import { EventEmitter } from "node:events";
import { TinderBrowser } from "./tinder.js";
import { classifyProfile } from "./classifier.js";
import { appendDecision, updateDecision, type Decision } from "./store.js";
import { loadSettings, updateSettings, type Settings } from "./config.js";

export type Status = "idle" | "launching" | "awaiting_login" | "running" | "stopping" | "stopped" | "waiting" | "error";

export interface SwiperState {
  status: Status;
  swipesThisSession: number;
  lastError: string | null;
  current: { name: string | null; fingerprint: string } | null;
  /** Review mode: the decision waiting for your swipe from the dashboard. */
  awaiting: { decisionId: string } | null;
  swiping: boolean;
  /** The batch in progress: when it started, when it will end, how many profiles so far. */
  batch: { startedAt: string; endsAt: string; plannedMinutes: number; evaluated: number } | null;
  /** When the next batch is scheduled to start (continuous mode). */
  nextBatchAt: string | null;
  /** Why the last batch ended. */
  lastBatchEnd: string | null;
}

/** Strip Tinder UI chrome out of the scraped card text. */
function cleanProfileText(text: string): string {
  const junk = /^(open profile|close profile|previous photo|next photo|photos?|photo \d+|nope|like|super like|rewind|first impressions?|hide|keyboard shortcut|press .* to .*)$/i;
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, arr) => l && !junk.test(l) && arr.indexOf(l) === i)
    .join("\n")
    .slice(0, 4000);
}

/** Move a timestamp forward to the next window between start and end hour (local time). */
function pushIntoActiveHours(t: Date, startHour: number, endHour: number): Date {
  const d = new Date(t);
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= startHour && h < endHour) return d;
  if (h >= endHour) d.setDate(d.getDate() + 1);
  d.setHours(startHour, Math.floor(rand(0, 45)), 0, 0);
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Swiper extends EventEmitter {
  state: SwiperState = {
    status: "idle",
    swipesThisSession: 0,
    lastError: null,
    current: null,
    awaiting: null,
    swiping: false,
    batch: null,
    nextBatchAt: null,
    lastBatchEnd: null,
  };
  private browser: TinderBrowser;
  private pendingChoice: { decisionId: string; direction: "like" | "pass" } | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;

  constructor() {
    super();
    this.browser = new TinderBrowser((m) => this.log(m));
  }

  log(message: string): void {
    this.emit("log", { at: new Date().toISOString(), message });
  }

  private setStatus(status: Status): void {
    this.state.status = status;
    this.emit("state", this.state);
  }

  /**
   * Start a run now (cancels any scheduled one).
   * "auto"  = a batch: swipes on its own for a random human-length session.
   * "review" = manual review: scores each card and waits for your swipe, until you stop it.
   */
  async start(mode: "auto" | "review" = "auto"): Promise<void> {
    if (this.loopPromise) return;
    this.cancelSchedule();
    this.stopRequested = false;
    this.state.swipesThisSession = 0;
    this.state.lastError = null;
    this.state.lastBatchEnd = null;
    const settings = updateSettings({ mode });
    if (mode === "auto") {
      const minutes = Math.round(rand(settings.batchMinMinutes, settings.batchMaxMinutes));
      const startedAt = new Date();
      this.state.batch = {
        startedAt: startedAt.toISOString(),
        endsAt: new Date(startedAt.getTime() + minutes * 60_000).toISOString(),
        plannedMinutes: minutes,
        evaluated: 0,
      };
      this.log(`Starting a ${minutes}-minute auto-swipe batch (like at P ≥ ${Math.round(settings.threshold * 100)}%).`);
    } else {
      this.state.batch = null;
      this.log("Starting manual review: I score each card, you swipe from the dashboard.");
    }
    this.loopPromise = this.run()
      .finally(() => {
        this.loopPromise = null;
      })
      .then(() => this.afterBatch());
  }

  private cancelSchedule(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    this.state.nextBatchAt = null;
  }

  /** Continuous mode: pick a break, push it into active hours, and schedule the next batch. */
  private afterBatch(): void {
    const settings = loadSettings();
    const endedByUser = this.stopRequested;
    if (endedByUser || this.state.status === "error" || !settings.continuous || settings.mode !== "auto") return;
    const breakMs = rand(settings.breakMinMinutes, settings.breakMaxMinutes) * 60_000;
    let next = new Date(Date.now() + breakMs);
    next = pushIntoActiveHours(next, settings.activeStartHour, settings.activeEndHour);
    this.state.nextBatchAt = next.toISOString();
    this.setStatus("waiting");
    this.log(`Next batch scheduled for ${next.toLocaleString()}.`);
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      void this.start("auto");
    }, Math.max(1000, next.getTime() - Date.now()));
  }

  private endBatch(reason: string): void {
    this.state.lastBatchEnd = reason;
    this.log(`Batch over: ${reason}`);
  }

  /** Review mode: the dashboard asks us to swipe the profile currently awaiting a decision. */
  requestSwipe(decisionId: string, direction: "like" | "pass"): { ok: boolean; error?: string } {
    if (this.state.status !== "running") return { ok: false, error: "Swiper is not running" };
    if (!this.state.awaiting || this.state.awaiting.decisionId !== decisionId) {
      return { ok: false, error: "That profile is no longer the one on screen" };
    }
    if (this.pendingChoice) return { ok: false, error: "A swipe is already in progress" };
    this.pendingChoice = { decisionId, direction };
    return { ok: true };
  }

  /** Wait for a swipe from the dashboard, or for the card to change because you swiped in the browser. */
  private async waitForChoice(fingerprint: string): Promise<"like" | "pass" | "browser" | null> {
    while (!this.stopRequested) {
      if (this.pendingChoice) return this.pendingChoice.direction;
      await this.browser.dismissPopups();
      const fp = await this.browser.currentFingerprint();
      if (fp && fp !== fingerprint) return "browser";
      await sleep(1200);
    }
    return null;
  }

  async stop(): Promise<void> {
    this.cancelSchedule();
    if (!this.loopPromise) {
      if (this.state.status === "waiting") this.setStatus("stopped");
      return;
    }
    this.stopRequested = true;
    this.setStatus("stopping");
    await this.loopPromise;
  }

  /** Launch the browser (if needed), get to the deck, and wait for a login if there isn't one. */
  private async openDeck(): Promise<boolean> {
    const launchSettings = loadSettings();
    if (this.browser.isOpen() && this.browser.headless !== launchSettings.headless) {
      this.log("Window setting changed; relaunching the browser.");
      await this.browser.close();
    }
    if (!this.browser.isOpen()) {
      this.log(launchSettings.headless ? "Launching headless browser…" : "Launching browser…");
      await this.browser.launch(launchSettings);
    }
    let loggedIn = await this.browser.gotoRecs();
    if (!loggedIn && this.browser.headless) {
      // You can't type an SMS code into a window you can't see.
      this.log("Not logged in; reopening with a visible window so you can log in.");
      await this.browser.close();
      await this.browser.launch(launchSettings, { headless: false });
      loggedIn = await this.browser.gotoRecs();
    }
    if (!loggedIn) {
      this.setStatus("awaiting_login");
      this.log("Not logged in. Log into Tinder in the browser window (phone number login is most reliable). Waiting up to 15 minutes…");
      const ok = await this.browser.waitForLogin(15 * 60_000, () => this.stopRequested);
      if (!ok) {
        this.log(this.stopRequested ? "Stopped while waiting for login." : "Timed out waiting for login.");
        return false;
      }
      this.log("Logged in.");
    }
    return true;
  }

  /** One batch: evaluate and swipe until the batch ends. Throws if the browser goes away. */
  private async batchLoop(): Promise<void> {
    let consecutiveFailures = 0;

    while (!this.stopRequested) {
      const settings = loadSettings();
      if (this.state.batch && Date.now() >= new Date(this.state.batch.endsAt).getTime()) {
        this.endBatch(`${this.state.batch.plannedMinutes}-minute batch finished (${this.state.batch.evaluated} profiles).`);
        break;
      }
      if (settings.mode === "auto" && this.state.swipesThisSession >= settings.maxSwipesPerSession) {
        this.endBatch(`reached the cap of ${settings.maxSwipesPerSession} swipes.`);
        break;
      }
      if (!this.browser.isOpen()) throw new Error("Browser is not open");

      if (!(await this.browser.ensureRecs())) {
        this.endBatch("could not get back to the swipe deck; check the browser window.");
        break;
      }
      await this.browser.dismissPopups();
      if (await this.browser.isOutOfLikes()) {
        this.endBatch("Tinder says you're out of likes.");
        break;
      }
      if (await this.browser.isOutOfProfiles()) {
        this.endBatch("Tinder has no more profiles to show right now.");
        break;
      }

      const profile = await this.browser.scrapeCurrentProfile(settings);
      if (!profile) {
        consecutiveFailures++;
        if (consecutiveFailures >= 5) {
          const shot = await this.browser.saveErrorScreenshot("no-card");
          this.endBatch(`no profile card found 5 times in a row${shot ? ` (screenshot: ${shot})` : ""}.`);
          break;
        }
        this.log("No profile card found; retrying…");
        await sleep(3000);
        continue;
      }
      consecutiveFailures = 0;
      if (this.state.batch) this.state.batch.evaluated++;
      this.state.current = { name: profile.name, fingerprint: profile.fingerprint };
      this.emit("state", this.state);
      this.log(`Evaluating ${profile.name ?? "unknown"}${profile.age ? `, ${profile.age}` : ""} (${profile.photos.length} photos)…`);

      const id = `${Date.now().toString(36)}-${profile.fingerprint}`;
      const photoUrls = this.browser.savePhotos(id, profile.photos);

      let decision: Decision;
      try {
        const result = await classifyProfile(
          { text: profile.text, photos: profile.photos, screenshot: profile.screenshot.length ? profile.screenshot : undefined },
          settings,
        );
        const c = result.classification;
        const likes = !!c && c.probability >= settings.threshold;
        let action: Decision["action"];
        if (!c) action = "skipped";
        else if (settings.mode === "auto") action = likes ? "like" : "pass";
        else action = likes ? "recommend_like" : "recommend_pass";
        decision = {
          id,
          at: new Date().toISOString(),
          mode: settings.mode,
          action,
          threshold: settings.threshold,
          name: c?.name ?? profile.name,
          age: c?.age ?? profile.age,
          photos: photoUrls,
          profileText: cleanProfileText(profile.text),
          classification: c,
          usage: result.usage,
          ...(result.refused ? { error: "Model declined to evaluate this profile." } : {}),
        };
      } catch (e) {
        const msg = (e as Error).message;
        this.log(`Classifier error: ${msg}`);
        decision = {
          id,
          at: new Date().toISOString(),
          mode: settings.mode,
          action: "skipped",
          threshold: settings.threshold,
          name: profile.name,
          age: profile.age,
          photos: photoUrls,
          profileText: cleanProfileText(profile.text),
          classification: null,
          error: msg,
        };
        if (/401|403|api key|authentication/i.test(msg)) {
          appendDecision(decision);
          this.emit("decision", decision);
          this.state.lastError = msg;
          this.setStatus("error");
          return;
        }
      }

      appendDecision(decision);
      this.emit("decision", decision);
      const p = decision.classification?.probability;
      this.log(`${decision.name ?? "unknown"}: P=${p === undefined ? "n/a" : p.toFixed(2)} → ${decision.action.replace("_", " ")}`);

      if (settings.mode === "auto") {
        // A profile the model declined to evaluate gets a pass: you only want likes on qualified profiles.
        const dir = decision.action === "like" ? "like" : "pass";
        if (!this.browser.onRecs()) {
          // Someone clicked around in the window. Go back to the deck and re-evaluate whatever is on top.
          this.log("Browser left the swipe deck before the swipe; going back and re-checking the card.");
          await this.browser.ensureRecs();
          continue;
        }
        if (settings.humanize) await this.browser.secondLook(dir === "like", p);
        await this.browser.swipe(dir);
        this.state.swipesThisSession++;
        this.emit("state", this.state);
        await sleep(rand(settings.minDelayMs, settings.maxDelayMs));
      } else {
        await this.browser.closeProfile();
        this.state.awaiting = { decisionId: id };
        this.emit("state", this.state);
        this.log("Review mode: choose Pass or Like in the dashboard (or swipe in the browser).");
        const choice = await this.waitForChoice(profile.fingerprint);
        this.state.awaiting = null;
        if (choice === "like" || choice === "pass") {
          this.state.swiping = true;
          this.emit("state", this.state);
          if (settings.humanize) await this.browser.secondLook(choice === "like", p);
          await this.browser.swipe(choice);
          this.state.swipesThisSession++;
          this.state.swiping = false;
          const recommendedLike = decision.action === "recommend_like";
          const verdict = !decision.classification
            ? null
            : (choice === "like") === recommendedLike
              ? "about_right"
              : choice === "like"
                ? "higher"
                : "lower";
          const updated = updateDecision(id, { userSwipe: choice, verdict });
          if (updated) this.emit("decision", updated);
          this.log(`You ${choice === "like" ? "liked" : "passed on"} ${decision.name ?? "this profile"}${verdict ? ` (model's P should be ${verdict.replace("_", " ")})` : ""}.`);
          await sleep(rand(settings.minDelayMs, settings.maxDelayMs));
        } else if (choice === "browser") {
          const updated = updateDecision(id, { userSwipe: "browser" });
          if (updated) this.emit("decision", updated);
        }
        this.pendingChoice = null;
        this.emit("state", this.state);
      }
    }
  }

  private async run(): Promise<void> {
    try {
      this.setStatus("launching");
      if (!(await this.openDeck())) {
        this.setStatus("stopped");
        return;
      }
      this.setStatus("running");

      // If the window gets closed mid-batch (by you, or a crash), reopen it and keep going.
      let relaunches = 0;
      while (!this.stopRequested) {
        try {
          await this.batchLoop();
          break;
        } catch (e) {
          const msg = (e as Error).message;
          const browserGone = /not open|has been closed|Target (page|context|browser)|browser has been closed|Session closed/i.test(msg);
          if (!browserGone || relaunches >= 3) throw e;
          relaunches++;
          this.log(`Browser went away (${msg.split("\n")[0].slice(0, 120)}); reopening it to continue the batch.`);
          await this.browser.close().catch(() => {});
          await sleep(2000);
          this.setStatus("launching");
          if (!(await this.openDeck())) {
            this.setStatus("stopped");
            return;
          }
          this.setStatus("running");
        }
      }
      if (this.stopRequested && !this.state.lastBatchEnd) this.state.lastBatchEnd = "stopped by you.";
      if (!this.stopRequested) {
        this.log("Closing the browser until the next batch.");
        await this.browser.close();
      }
      this.setStatus("stopped");
    } catch (e) {
      const msg = (e as Error).message;
      this.state.lastError = msg;
      this.log(`Error: ${msg}`);
      await this.browser.saveErrorScreenshot("crash").catch(() => null);
      this.setStatus("error");
    } finally {
      this.state.batch = null;
      this.state.current = null;
      this.state.awaiting = null;
      this.state.swiping = false;
      this.pendingChoice = null;
      this.emit("state", this.state);
    }
  }

  /** Diagnostic: make sure the browser is open on recs, then inspect the DOM. */
  async inspect(openProfile = false): Promise<unknown> {
    if (!this.browser.isOpen()) {
      await this.browser.launch(loadSettings());
      await this.browser.gotoRecs();
    }
    return this.browser.inspect(openProfile);
  }

  async shutdown(): Promise<void> {
    await this.stop();
    await this.browser.close();
  }
}
