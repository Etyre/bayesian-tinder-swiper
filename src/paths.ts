import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DATA_DIR = path.join(ROOT, "data");
export const PHOTOS_DIR = path.join(DATA_DIR, "photos");
export const ERRORS_DIR = path.join(DATA_DIR, "errors");
export const PROFILE_DIR = path.join(DATA_DIR, "browser-profile");
export const DECISIONS_FILE = path.join(DATA_DIR, "decisions.jsonl");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const PUBLIC_DIR = path.join(ROOT, "public");

for (const d of [DATA_DIR, PHOTOS_DIR, ERRORS_DIR, PROFILE_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}
