import fs from "node:fs";
import { z } from "zod";
import { SETTINGS_FILE } from "./paths.js";

export const SettingsSchema = z.object({
  /** "review": classify, show recommendation, wait for you to swipe by hand.
   *  "auto": swipe automatically based on the classifier. */
  mode: z.enum(["review", "auto"]).default("review"),
  /** Swipe right when P(meets criteria) >= threshold. */
  threshold: z.number().min(0).max(1).default(0.5),
  /** Prior probability (0-1) that a random woman in your pool meets the criteria.
   *  Drives the Bayesian reasoning in the prompt. */
  prior: z.number().min(0.005).max(0.9).default(0.1),
  /** Each run is a "batch": a random session length like a person swiping for a while, then stopping. */
  batchMinMinutes: z.number().min(1).max(600).default(10),
  batchMaxMinutes: z.number().min(1).max(600).default(50),
  /** After a batch, wait a random break and start the next one automatically. */
  continuous: z.boolean().default(false),
  breakMinMinutes: z.number().min(1).max(10_000).default(90),
  breakMaxMinutes: z.number().min(1).max(10_000).default(360),
  /** Only start batches between these local hours (24h). Start 9, end 23 = 9:00-22:59. */
  activeStartHour: z.number().int().min(0).max(23).default(9),
  activeEndHour: z.number().int().min(1).max(24).default(23),
  /** Stop after this many swipes in one run (Tinder bans aggressive bots). */
  maxSwipesPerSession: z.number().int().min(1).max(1000).default(100),
  /** Random human-like delay between swipes, in ms. */
  minDelayMs: z.number().int().min(500).default(2500),
  maxDelayMs: z.number().int().min(500).default(7000),
  /** Browse like a person: skim a random number of photos with variable dwell,
   *  occasionally flip back, scroll the bio, take a longer second look at profiles you like. */
  humanize: z.boolean().default(true),
  /** How often to flip through all the photos before judging (0-1). Otherwise judge on the bio
   *  plus whatever photo is already showing, like a person skimming. */
  photoFlipChance: z.number().min(0).max(1).default(0.25),
  /** How many photos to send to the classifier. */
  maxPhotos: z.number().int().min(0).max(9).default(5),
  model: z
    .enum(["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-opus-4-8", "claude-haiku-4-5"])
    .default("claude-opus-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** Free-text guidance for the model, e.g. how you want borderline diets treated. Goes into every prompt. */
  userGuidance: z.string().max(4000).default(""),
  /** Run the browser without a visible window. Login always uses a visible window. */
  headless: z.boolean().default(false),
  /** Browser channel. "chrome" = your installed Google Chrome (less bot-like). */
  browserChannel: z.enum(["chrome", "chromium"]).default("chrome"),
});
export type Settings = z.infer<typeof SettingsSchema>;

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return SettingsSchema.parse(raw);
  } catch {
    const s = SettingsSchema.parse({});
    saveSettings(s);
    return s;
  }
}

export function saveSettings(s: Settings): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

export function updateSettings(patch: unknown): Settings {
  const merged = { ...loadSettings(), ...(patch as object) };
  const s = SettingsSchema.parse(merged);
  if (s.minDelayMs > s.maxDelayMs) s.maxDelayMs = s.minDelayMs;
  if (s.batchMinMinutes > s.batchMaxMinutes) s.batchMaxMinutes = s.batchMinMinutes;
  if (s.breakMinMinutes > s.breakMaxMinutes) s.breakMaxMinutes = s.breakMinMinutes;
  saveSettings(s);
  return s;
}
