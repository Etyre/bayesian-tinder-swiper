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
  /** Your verdict on the model's call. Derived from your swipe in review mode, or set by hand. */
  verdict?: "agree" | "disagree" | null;
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
      out.push(JSON.parse(line));
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

export function setVerdict(id: string, verdict: Decision["verdict"]): Decision | null {
  return updateDecision(id, { verdict });
}

export function stats(): {
  seen: number;
  liked: number;
  passed: number;
  recommendedLike: number;
  agreed: number;
  disagreed: number;
} {
  const all = readDecisions(100_000);
  return {
    seen: all.length,
    liked: all.filter((d) => d.action === "like").length,
    passed: all.filter((d) => d.action === "pass").length,
    recommendedLike: all.filter((d) => d.action === "recommend_like").length,
    agreed: all.filter((d) => d.verdict === "agree").length,
    disagreed: all.filter((d) => d.verdict === "disagree").length,
  };
}
