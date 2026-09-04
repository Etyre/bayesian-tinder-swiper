import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROFILE_DIR, PHOTOS_DIR, ERRORS_DIR } from "./paths.js";
import type { Settings } from "./config.js";

export type Photo = { data: Buffer; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; url: string };

export interface ScrapedProfile {
  fingerprint: string;
  name: string | null;
  age: number | null;
  text: string;
  photos: Photo[];
  screenshot: Buffer;
}

const RECS_URL = "https://tinder.com/app/recs";

/** Only buttons that dismiss Tinder's own upsells and match screens. Nothing generic
 *  like "Continue", "OK", "Close" or "Accept": those exist in purchase and profile flows too. */
const DISMISS_BUTTON_RE = /^(not interested|no thanks|maybe later|keep swiping|back to tinder|i.ll pass|not now)$/i;
/** The swipe deck. Opening a card's profile changes the URL to /app/recs/profile; that's still the deck. */
const RECS_PATH_RE = /^https:\/\/tinder\.com\/app\/recs(\/profile)?\/?(\?.*)?$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));
const chance = (p: number) => Math.random() < p;
/** Right-skewed dwell time: mostly short glances, occasionally a long look. */
const dwell = (base: number) => Math.round(base * Math.exp(rand(-0.6, 0.9)));

/**
 * page.evaluate(fn) serializes fn's source; tsx/esbuild injects `__name(...)`
 * helper calls into that source, which don't exist in the browser. Define a
 * no-op shim before invoking.
 */
async function evalInPage<T>(page: Page, fn: () => T): Promise<T> {
  const src = `(() => { globalThis.__name = globalThis.__name || ((f) => f); return (${fn.toString()})(); })()`;
  return (await page.evaluate(src)) as T;
}

const OUT_OF_LIKES_RE = /out of likes|you.re out of likes|get more likes|likes will replenish/i;

export class TinderBrowser {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  constructor(private log: (msg: string) => void) {}

  headless = false;

  async launch(settings: Settings, opts: { headless?: boolean } = {}): Promise<void> {
    this.headless = opts.headless ?? settings.headless;
    const common = {
      headless: this.headless,
      viewport: { width: 1200, height: 900 },
      locale: "en-US",
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    };
    try {
      this.ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        ...common,
        channel: settings.browserChannel === "chrome" ? "chrome" : undefined,
      });
    } catch (e) {
      this.log(`Could not launch ${settings.browserChannel} (${(e as Error).message.split("\n")[0]}); falling back to bundled Chromium.`);
      this.ctx = await chromium.launchPersistentContext(PROFILE_DIR, common);
    }
    await this.ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.ctx.on("close", () => {
      this.ctx = null;
      this.page = null;
    });
  }

  isOpen(): boolean {
    return !!this.page && !this.page.isClosed();
  }

  async close(): Promise<void> {
    try {
      await this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
    this.page = null;
  }

  private p(): Page {
    if (!this.page || this.page.isClosed()) throw new Error("Browser is not open");
    return this.page;
  }

  /** True only when the swipe deck is the current page. Every click and keypress checks this. */
  onRecs(): boolean {
    return RECS_PATH_RE.test(this.p().url());
  }

  /** If we drifted off the swipe deck (wrong click, Tinder redirect), go straight back by URL. No clicking. */
  async ensureRecs(): Promise<boolean> {
    if (this.onRecs()) return true;
    this.log(`Browser is on ${this.p().url()}, not the swipe deck. Navigating back to it.`);
    await this.p().goto(RECS_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.p().waitForTimeout(2500);
    return this.onRecs();
  }

  /** Navigate to recs; returns true if we appear logged in. */
  async gotoRecs(): Promise<boolean> {
    const page = this.p();
    if (!page.url().startsWith("https://tinder.com/app/")) {
      await page.goto(RECS_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await page.waitForTimeout(2500);
    return this.isLoggedIn();
  }

  async isLoggedIn(): Promise<boolean> {
    const page = this.p();
    if (!page.url().includes("/app/")) return false;
    // Login page shows "Log in" / "Create account" buttons; the app shows the recs card board.
    const loginBtn = page.getByRole("button", { name: /^log in$/i }).first();
    if (await loginBtn.isVisible().catch(() => false)) return false;
    return true;
  }

  /** Block until logged in (user does it by hand in the visible window). */
  async waitForLogin(timeoutMs: number, shouldStop: () => boolean): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldStop()) return false;
      if (await this.isLoggedIn()) {
        if (!this.p().url().includes("/app/recs")) {
          await this.p().goto(RECS_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
        }
        return true;
      }
      await this.p().waitForTimeout(2000);
    }
    return false;
  }

  /** Close any modal / upsell / match popup that blocks the card board. */
  async dismissPopups(): Promise<void> {
    const page = this.p();
    if (!this.onRecs()) return;
    for (let round = 0; round < 3; round++) {
      let clicked = false;
      // Only look inside modal dialogs; never at header/nav/sidebar buttons.
      const buttons = page.locator("[role='dialog'] button, [aria-modal='true'] button");
      const n = await buttons.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 60); i++) {
        const b = buttons.nth(i);
        const label = ((await b.textContent().catch(() => "")) ?? "").trim() || ((await b.getAttribute("aria-label").catch(() => "")) ?? "");
        if (DISMISS_BUTTON_RE.test(label.trim()) && (await b.isVisible().catch(() => false))) {
          // "Close" inside the profile card is fine to click too; it just collapses the profile.
          await b.click({ timeout: 2000 }).catch(() => {});
          clicked = true;
          await page.waitForTimeout(600);
          break;
        }
      }
      // "It's a Match" overlay
      const matchOverlay = page.getByText(/it.s a match/i).first();
      if (await matchOverlay.isVisible().catch(() => false)) {
        this.log("Match! Dismissing the match screen.");
        const keep = page.getByRole("button", { name: /keep swiping|back to tinder|not now/i }).first();
        if (await keep.isVisible().catch(() => false)) await keep.click().catch(() => {});
        else await page.keyboard.press("Escape").catch(() => {});
        clicked = true;
        await page.waitForTimeout(800);
      }
      if (!clicked) break;
    }
  }

  async isOutOfProfiles(): Promise<boolean> {
    const text = await this.p().evaluate(() => document.body.innerText).catch(() => "");
    return /there.s no one new around you|no one new around you|run out of potential matches|go global/i.test(text);
  }

  async isOutOfLikes(): Promise<boolean> {
    const text = await this.p().evaluate(() => document.body.innerText).catch(() => "");
    return OUT_OF_LIKES_RE.test(text);
  }

  /** Fingerprint of the card currently on top (name + first photo url). */
  async currentFingerprint(): Promise<string | null> {
    const info = await evalInPage(this.p(), cardInfoInPage).catch(() => null);
    if (!info || (!info.name && info.photoUrls.length === 0)) return null;
    return crypto.createHash("sha1").update(`${info.name}|${info.age}|${info.photoUrls[0] ?? ""}`).digest("hex").slice(0, 12);
  }

  async scrapeCurrentProfile(settings: Settings): Promise<ScrapedProfile | null> {
    const page = this.p();
    if (!(await this.ensureRecs())) return null;
    await this.dismissPopups();
    // Start from the collapsed card: photos only load while flipping in this view.
    if (page.url().includes("/recs/profile")) await this.closeProfile();

    let info = await evalInPage(page, cardInfoInPage).catch(() => null);
    if (!info || (!info.name && !info.text)) return null;
    const name = info.name;
    const age = info.age;

    // 1. Flip through the photos in the collapsed card, merging URLs after each flip.
    //    Tinder renders only the current photo and its neighbour, so we must look after every flip.
    const flipThrough = settings.maxPhotos > 1 && chance(settings.photoFlipChance);
    const wanted = flipThrough ? Math.min(Math.max(info.photoCount, 1), settings.maxPhotos) : 1;
    const urlSet = new Set(info.photoUrls);
    let flips = 0;
    for (; flipThrough && flips < wanted + 2 && urlSet.size < wanted; flips++) {
      await this.nextPhoto();
      await page.waitForTimeout(settings.humanize ? dwell(900) : 300);
      const again = await evalInPage(page, cardInfoInPage).catch(() => null);
      if (!again || again.name !== name) break; // card changed under us
      again.photoUrls.forEach((u) => urlSet.add(u));
    }
    if (settings.humanize && flips >= 2 && chance(0.2)) {
      await sleep(dwell(600));
      await this.prevPhoto();
      await sleep(dwell(1200));
    }

    // 2. Open the profile and read it (text, badges, bio).
    await sleep(settings.humanize ? dwell(700) : 200);
    await this.openProfile();
    if (settings.humanize && chance(0.7)) await this.scrollBio();
    const opened = await evalInPage(page, cardInfoInPage).catch(() => null);
    if (opened?.text) {
      info = { ...opened, name: opened.name ?? name, age: opened.age ?? age };
      opened.photoUrls.forEach((u) => urlSet.add(u));
    }
    info.photoUrls = Array.from(urlSet);
    if (!info.name) {
      // The opened view ends with "Block <name>" / "Report <name>".
      const m = info.text.match(/^(?:Block|Report) (.+)$/m);
      if (m) info.name = m[1].trim();
    }
    if (!flipThrough) info.photoUrls = info.photoUrls.slice(0, 2); // just what was on screen
    this.log(flipThrough
      ? `Photos: flipped through, captured ${info.photoUrls.length} of ${Math.max(info.photoCount, wanted)}.`
      : `Photos: didn't flip, judging on the bio and ${info.photoUrls.length} visible photo${info.photoUrls.length === 1 ? "" : "s"}.`);

    // 3. Occasionally get distracted, like a person would.
    if (settings.humanize && chance(0.04)) {
      const pause = randInt(12_000, 40_000);
      this.log(`Pausing ${Math.round(pause / 1000)}s.`);
      await sleep(pause);
    }

    const fingerprint = crypto
      .createHash("sha1")
      .update(`${info.name}|${info.age}|${info.photoUrls[0] ?? ""}`)
      .digest("hex")
      .slice(0, 12);

    const screenshot = await page.screenshot({ type: "png" }).catch(() => Buffer.alloc(0));

    const photos: Photo[] = [];
    for (const url of info.photoUrls.slice(0, settings.maxPhotos)) {
      const photo = await this.fetchPhoto(url);
      if (photo) photos.push(photo);
    }

    return { fingerprint, name: info.name, age: info.age, text: info.text, photos, screenshot };
  }

  private async openProfile(): Promise<void> {
    const page = this.p();
    if (!this.onRecs()) return;
    const openBtn = page.getByRole("button", { name: /open profile/i }).first();
    if (await openBtn.isVisible().catch(() => false)) {
      await this.wander();
      await openBtn.click({ timeout: 2000 }).catch(() => {});
    } else {
      await page.keyboard.press("ArrowUp").catch(() => {});
    }
    await page.waitForTimeout(dwell(900));
  }

  /** Move the mouse in a few lazy steps somewhere over the card, like a hand resting on the trackpad. */
  private async wander(): Promise<void> {
    const page = this.p();
    const vp = page.viewportSize() ?? { width: 1200, height: 900 };
    const x = rand(vp.width * 0.3, vp.width * 0.7);
    const y = rand(vp.height * 0.25, vp.height * 0.75);
    await page.mouse.move(x, y, { steps: randInt(6, 18) }).catch(() => {});
  }

  /** The card on top of the deck, or the opened profile view that replaces it. */
  private activeCard() {
    return this.p().locator(".recsCardboard__cards > [aria-hidden='false'], .profileCard__card").first();
  }

  /** Click a photo-nav button in the active card if it's there (opened profile), else use the keyboard. */
  private async photoNav(label: "Next Photo" | "Previous Photo"): Promise<void> {
    const page = this.p();
    if (!this.onRecs()) return;
    const btn = this.activeCard().locator(`[aria-label='${label}']`).first();
    if (await btn.isVisible().catch(() => false)) {
      const box = await btn.boundingBox().catch(() => null);
      if (box) await page.mouse.move(box.x + box.width * rand(0.3, 0.7), box.y + box.height * rand(0.3, 0.7), { steps: randInt(4, 10) }).catch(() => {});
      await btn.click({ timeout: 1500 }).catch(() => {});
      return;
    }
    if (label === "Next Photo") {
      await page.keyboard.press("Space").catch(() => {});
      return;
    }
    // Collapsed card: clicking the left third of the card's own photo goes back.
    // Scoped to the active card: the header avatar is also labelled "Profile Photo".
    const photo = this.activeCard().locator("[aria-label^='Profile Photo']").filter({ visible: true }).first();
    const box = await photo.boundingBox().catch(() => null);
    if (!box) return;
    await page.mouse.move(box.x + box.width * rand(0.08, 0.25), box.y + box.height * rand(0.3, 0.7), { steps: randInt(5, 12) }).catch(() => {});
    await page.mouse.down().catch(() => {});
    await sleep(rand(40, 120));
    await page.mouse.up().catch(() => {});
  }

  private async nextPhoto(): Promise<void> {
    await this.photoNav("Next Photo");
  }

  private async prevPhoto(): Promise<void> {
    await this.photoNav("Previous Photo");
  }

  /** Scroll the opened profile's details pane a bit, like reading the bio. */
  private async scrollBio(): Promise<void> {
    const page = this.p();
    if (!this.onRecs()) return;
    await this.wander();
    const downSteps = randInt(1, 4);
    for (let i = 0; i < downSteps; i++) {
      await page.mouse.wheel(0, rand(120, 420)).catch(() => {});
      await sleep(dwell(700));
    }
    if (chance(0.5)) {
      // Glance back up at something.
      await page.mouse.wheel(0, -rand(100, 300)).catch(() => {});
      await sleep(dwell(500));
    }
  }

  /**
   * After the model has decided: linger on profiles we like (people look longer
   * at someone they're about to swipe right on), flick past most passes.
   */
  async secondLook(liked: boolean, probability: number | undefined): Promise<void> {
    if (!this.onRecs()) return;
    const nearThreshold = probability !== undefined && Math.abs(probability - 0.5) < 0.15;
    if (liked && chance(0.7)) {
      const n = randInt(1, 3);
      for (let i = 0; i < n; i++) {
        await sleep(dwell(1500));
        await (chance(0.3) ? this.prevPhoto() : this.nextPhoto());
      }
      await sleep(dwell(1000));
    } else if (nearThreshold && chance(0.5)) {
      await sleep(dwell(1200));
      await this.nextPhoto();
      await sleep(dwell(1200));
    } else if (chance(0.15)) {
      await sleep(dwell(900));
      await this.nextPhoto();
    }
    if (chance(0.5)) await this.wander();
  }

  private async fetchPhoto(url: string): Promise<Photo | null> {
    try {
      const res = await this.p().request.get(url, { timeout: 8000 });
      if (!res.ok()) return null;
      const ct = (res.headers()["content-type"] ?? "").toLowerCase();
      let mediaType: Photo["mediaType"] = "image/jpeg";
      if (ct.includes("png")) mediaType = "image/png";
      else if (ct.includes("webp")) mediaType = "image/webp";
      else if (ct.includes("gif")) mediaType = "image/gif";
      const data = await res.body();
      if (data.length < 1000 || data.length > 5_000_000) return null;
      return { data, mediaType, url };
    } catch {
      return null;
    }
  }

  /** Persist photos to disk for the dashboard; returns relative URLs. */
  savePhotos(id: string, photos: Photo[]): string[] {
    const dir = path.join(PHOTOS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    return photos.map((p, i) => {
      const ext = p.mediaType.split("/")[1];
      const file = path.join(dir, `${i}.${ext}`);
      fs.writeFileSync(file, p.data);
      return `/photos/${id}/${i}.${ext}`;
    });
  }

  async closeProfile(): Promise<void> {
    const page = this.p();
    if (!this.onRecs()) return;
    const closeBtn = page.getByRole("button", { name: /close profile/i }).first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ timeout: 2000 }).catch(() => {});
    } else {
      await page.keyboard.press("ArrowDown").catch(() => {});
    }
    await page.waitForTimeout(500);
  }

  async swipe(direction: "like" | "pass"): Promise<void> {
    const page = this.p();
    if (!this.onRecs()) throw new Error(`Refusing to swipe: browser is on ${page.url()}, not the swipe deck`);
    await this.closeProfile();
    const btnName = direction === "like" ? /^like$/i : /^nope$/i;
    const btn = page.getByRole("button", { name: btnName }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(async () => {
        await page.keyboard.press(direction === "like" ? "ArrowRight" : "ArrowLeft");
      });
    } else {
      await page.keyboard.press(direction === "like" ? "ArrowRight" : "ArrowLeft");
    }
    await page.waitForTimeout(1200);
    await this.dismissPopups();
  }

  /** Wait until the top card changes (user swiped by hand in review mode). */
  async waitForCardChange(fingerprint: string, shouldStop: () => boolean): Promise<void> {
    while (!shouldStop()) {
      await this.dismissPopups();
      const fp = await this.currentFingerprint();
      if (fp && fp !== fingerprint) return;
      await this.p().waitForTimeout(1500);
    }
  }

  /** Diagnostic: run the extractor and summarize what the page looks like. */
  async inspect(openProfile = false): Promise<unknown> {
    const page = this.p();
    if (openProfile) await this.openProfile();
    let info: unknown = null;
    let error: string | null = null;
    try {
      info = await evalInPage(page, cardInfoInPage);
    } catch (e) {
      error = (e as Error).message;
    }
    const summary = await page
      .evaluate(() => {
        const board = document.querySelector(".recsCardboard__cards");
        const kids = board ? Array.from(board.querySelectorAll(":scope > *, :scope > * > *")) : [];
        return {
          boardSelector: board ? board.className : null,
          profileCard: !!document.querySelector(".profileCard__card"),
          boardChildren: kids.map((k) => ({
            tag: k.tagName,
            cls: k.className.toString().slice(0, 80),
            ariaHidden: k.getAttribute("aria-hidden"),
            rect: (() => { const r = k.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
            textLen: ((k as HTMLElement).innerText ?? "").length,
            name: k.querySelector("[itemprop='name']")?.textContent ?? null,
            z: getComputedStyle(k).zIndex,
            photoLabels: Array.from(k.querySelectorAll("[aria-label*='Photo']")).map((e) => e.getAttribute("aria-label")).slice(0, 8),
          })),
          h1s: Array.from(document.querySelectorAll("h1")).map((h) => (h as HTMLElement).innerText.slice(0, 60)),
          photoLabels: Array.from(document.querySelectorAll("[aria-label*='Photo' i]")).map((d) => d.getAttribute("aria-label")).slice(0, 12),
          bgImageCount: document.querySelectorAll("[style*='background-image']").length,
          bgUrls: Array.from(document.querySelectorAll<HTMLElement>("[style*='background-image']"))
            .map((el) => ({
              url: (el.style.backgroundImage.match(/url\((.*?)\)/)?.[1] ?? "").slice(0, 90),
              inCards: !!el.closest(".recsCardboard__cards"),
              label: el.getAttribute("aria-label"),
              visible: el.getBoundingClientRect().width > 50,
            }))
            .filter((x) => x.url && !/static-assets/.test(x.url) && /photo/i.test(x.label ?? ""))
            .slice(0, 12),
          classesWithCard: Array.from(new Set(Array.from(document.querySelectorAll("[class*='card' i]")).map((e) => e.className.toString().slice(0, 60)))).slice(0, 15),
          mainTextSample: (document.querySelector("main") as HTMLElement | null)?.innerText.slice(0, 600) ?? null,
        };
      })
      .catch((e) => ({ summaryError: (e as Error).message }));
    return { url: page.url(), onRecs: this.onRecs(), error, info, summary };
  }

  async saveErrorScreenshot(tag: string): Promise<string | null> {
    try {
      const file = path.join(ERRORS_DIR, `${Date.now()}-${tag}.png`);
      await this.p().screenshot({ path: file });
      return file;
    } catch {
      return null;
    }
  }
}

/**
 * Runs inside the page. Finds the active recommendation card and pulls out
 * name, age, all text, and photo URLs. Deliberately heuristic: Tinder's class
 * names are obfuscated and change, so we lean on ARIA and structure.
 */
function cardInfoInPage(): { name: string | null; age: number | null; text: string; photoUrls: string[]; photoCount: number } {
  const isVisible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return false;
    let node: Element | null = el;
    while (node) {
      if (node.getAttribute("aria-hidden") === "true") return false;
      node = node.parentElement;
    }
    return true;
  };

  // 1. Locate the active card. Prefer the recs card board's visible child.
  let card: Element | null = null;
  const board = document.querySelector(".recsCardboard__cards") ?? document.querySelector("[class*='recsCardboard__cards']");
  if (board) {
    // Tinder marks the card on top with aria-hidden="false"; preloaded cards behind it get "true".
    const kids = Array.from(board.children);
    card =
      board.querySelector(":scope > [aria-hidden='false']") ??
      kids.find((k) => k.getAttribute("aria-hidden") !== "true" && isVisible(k)) ??
      kids[kids.length - 1] ??
      null;
  }
  if (!card && /^\/app\/recs(\/profile)?\/?$/.test(location.pathname)) {
    // Opened profile: Tinder swaps the deck for a single profileCard view at /app/recs/profile.
    card = document.querySelector(".profileCard__card, [class*='profileCard__card']");
  }
  if (!card) {
    // No deck on this page (settings, your own profile, matches...). Never scrape anything else.
    return { name: null, age: null, text: "", photoUrls: [], photoCount: 0 };
  }

  // 2. Photo URLs, in order. Card photos are divs labelled "Profile Photo N"
  // (collapsed card) or "Photo N" (opened profile gallery) with an inline
  // background-image. The matches sidebar uses the same CDN, so scope to the
  // card board / gallery and skip static icons. Tinder serves several sizes of
  // the same image; keep one per image id, preferring the largest.
  const byId = new Map<string, { url: string; area: number; order: number }>();
  const bgUrl = (el: HTMLElement): string | null => {
    const m = el.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    return m?.[1] ?? null;
  };
  const consider = (el: HTMLElement, order: number) => {
    const candidates: HTMLElement[] = [el, ...Array.from(el.querySelectorAll<HTMLElement>("[style*='background-image']"))];
    for (const c of candidates) {
      const url = bgUrl(c);
      if (!url || !/^https?:\/\//.test(url) || /static-assets|\/icons\//.test(url)) continue;
      const sizeMatch = url.match(/\/(\d+)x(\d+)_([0-9a-f-]{8,})/i);
      const id = sizeMatch ? sizeMatch[3] : url;
      const area = sizeMatch ? parseInt(sizeMatch[1], 10) * parseInt(sizeMatch[2], 10) : 0;
      const prev = byId.get(id);
      if (!prev || area > prev.area) byId.set(id, { url, area, order: prev?.order ?? order });
    }
  };
  const isPhotoLabel = (el: Element) => /^(profile )?photo \d+$/i.test(el.getAttribute("aria-label") ?? "");
  const labelled = Array.from(card.querySelectorAll<HTMLElement>("[aria-label]")).filter(isPhotoLabel);
  labelled.forEach((el, i) => consider(el, i));
  // How many photos does the card say it has? ("Photo 1".."Photo N" in the opened gallery)
  const photoCount = Math.max(
    labelled.filter((el) => /^photo \d+$/i.test(el.getAttribute("aria-label") ?? "")).length,
    labelled.length ? 1 : 0,
  );
  if (byId.size === 0) {
    // Fallback: anything with a background image inside the card.
    card.querySelectorAll<HTMLElement>("[style*='background-image']").forEach((el, i) => consider(el, 100 + i));
  }
  const urls = Array.from(byId.values())
    .sort((a, b) => a.order - b.order)
    .map((x) => x.url);

  // 3. Name and age. Tinder marks them up with itemprop; fall back to an h1.
  let name: string | null = null;
  let age: number | null = null;
  // In the opened-profile view (/app/recs/profile) the name header sits outside the card container.
  // Your own profile page is /app/profile, which the URL guard never reaches, so this stays deck-only.
  const openedView = location.pathname.startsWith("/app/recs/profile");
  const nameEl = card.querySelector("[itemprop='name']") ?? (openedView ? document.querySelector("[itemprop='name']") : null);
  const ageEl = card.querySelector("[itemprop='age']") ?? (openedView ? document.querySelector("[itemprop='age']") : null);
  if (nameEl?.textContent?.trim()) name = nameEl.textContent.trim();
  if (ageEl?.textContent?.trim()) age = parseInt(ageEl.textContent.trim(), 10) || null;
  const h1 = card.querySelector("h1");
  if (!name && h1) {
    const spans = Array.from(h1.querySelectorAll("span")).map((s) => s.textContent?.trim() ?? "");
    const parts = spans.length ? spans : h1.textContent?.trim().split(/\s+/) ?? [];
    for (const part of parts) {
      if (/^\d{2}$/.test(part)) age = parseInt(part, 10);
      else if (part && !name) name = part;
    }
  }

  // 4. Text. innerText respects visibility and layout.
  let text = (card as HTMLElement).innerText ?? card.textContent ?? "";
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return { name, age, text, photoUrls: urls, photoCount };
}
