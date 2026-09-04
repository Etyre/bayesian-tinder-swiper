import fs from "node:fs";
import { DECISIONS_FILE } from "./paths.js";
import type { Classification } from "./classifier.js";

export interface Decision {
  id: string;
  at: string; // ISO timestamp
  mode: "review" | "auto";
  action: "like" | "pass" | "recommend_like" | "recommend_pass" | "skipped";
  threshold: number;
  name: string | null;
  age: number | null;
  photos: string[]; // relative URLs under /photos/
  classification: Classification | null;
  error?: string;
  usage?: { input: number; output: number; cacheRead: number };
  /** Scraped profile text so the dashboard can show the bio. */
  profileText?: string;
  /** What you did in review mode: swiped from the dashboard, or by hand in the browser. */
  userSwipe?: "like" | "pass" | "browser" | null;
  /** Your grade of the model's probability: should it have been higher, lower, or was it about right? */
  verdict?: Verdict | null;
  /** Your own probability estimate for this profile, if you gave one. */
  userProbability?: number | null;
  /** Your free-text note about this call. Fed back to the model as a calibration example. */
  note?: string | null;
}

export type Verdict = "higher" | "about_right" | "lower";

/** Older logs used agree/disagree; translate on read. */
function normalizeVerdict(d: Decision): Decision {
  const legacy = d.verdict as unknown as string | null | undefined;
  if (legacy === "agree") d.verdict = "about_right";
  else if (legacy === "disagree") d.verdict = /pass$/.test(d.action) ? "higher" : "lower";
  return d;
}

export function appendDecision(d: Decision): void {
  fs.appendFileSync(DECISIONS_FILE, JSON.stringify(d) + "\n");
}

export function readDecisions(limit = 200): Decision[] {
  if (!fs.existsSync(DECISIONS_FILE)) return [];
  const lines = fs.readFileSync(DECISIONS_FILE, "utf8").trim().split("\n").filter(Boolean);
  const out: Decision[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(normalizeVerdict(JSON.parse(line)));
    } catch {
      /* skip corrupt line */
    }
  }
  return out.reverse();
}

export function updateDecision(id: string, patch: Partial<Decision>): Decision | null {
  if (!fs.existsSync(DECISIONS_FILE)) return null;
  const lines = fs.readFileSync(DECISIONS_FILE, "utf8").split("\n");
  let updated: Decision | null = null;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const d = JSON.parse(line) as Decision;
      if (d.id !== id) return line;
      updated = { ...d, ...patch };
      return JSON.stringify(updated);
    } catch {
      return line;
    }
  });
  if (updated) fs.writeFileSync(DECISIONS_FILE, out.join("\n"));
  return updated;
}

export function setVerdict(id: string, verdict: Verdict | null, userProbability?: number | null): Decision | null {
  const patch: Partial<Decision> = { verdict };
  if (userProbability !== undefined) patch.userProbability = userProbability;
  return updateDecision(id, patch);
}

/** Graded or annotated decisions, newest first, for feeding back into the prompt. */
export function feedbackExamples(limit = 40): Decision[] {
  return readDecisions(100_000)
    .filter((d) => d.classification && (d.verdict || (d.note && d.note.trim()) || typeof d.userProbability === "number"))
    .slice(0, limit);
}

export function stats(): {
  seen: number;
  liked: number;
  passed: number;
  recommendedLike: number;
  higher: number;
  lower: number;
  aboutRight: number;
  /** Mean of (your estimate - model's probability) where you gave an estimate; positive = model too low. */
  meanBias: number | null;
  biasCount: number;
} {
  const all = readDecisions(100_000);
  const withEstimate = all.filter((d) => typeof d.userProbability === "number" && d.classification);
  const meanBias = withEstimate.length
    ? withEstimate.reduce((acc, d) => acc + (d.userProbability! - d.classification!.probability), 0) / withEstimate.length
    : null;
  return {
    seen: all.length,
    liked: all.filter((d) => d.action === "like").length,
    passed: all.filter((d) => d.action === "pass").length,
    recommendedLike: all.filter((d) => d.action === "recommend_like").length,
    higher: all.filter((d) => d.verdict === "higher").length,
    lower: all.filter((d) => d.verdict === "lower").length,
    aboutRight: all.filter((d) => d.verdict === "about_right").length,
    meanBias,
    biasCount: withEstimate.length,
  };
}
