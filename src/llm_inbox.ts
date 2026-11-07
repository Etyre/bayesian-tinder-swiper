/**
 * Glue to the shared LLM inbox in ../shared (see shared/README.md): every system prompt starts with
 * Eli's preamble word for word, every call offers the `contact_eli` tool, and every response is run
 * through shared/llm_contact.py. When the model contacts Eli the record is written to
 * ~/Library/Application Support/LLMInbox/messages.jsonl, he is notified, and the caller must stop.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type Anthropic from "@anthropic-ai/sdk";
import { ROOT } from "./paths.js";

export const APP_NAME = "tinder-swiper";
export const SHARED_DIR = process.env.AGENT_CODING_SHARED ?? path.resolve(ROOT, "..", "shared");
const PREAMBLE_FILE = path.join(SHARED_DIR, "llm-system-prompt-preamble.md");
const TOOL_FILE = path.join(SHARED_DIR, "contact_eli_tool.json");
const CHECKER = path.join(SHARED_DIR, "llm_contact.py");

/** The preamble, read on every call so an edit to the shared file applies without a restart.
 *  Throws if it is missing: a prompt without it must not be sent. */
export function preamble(): string {
  return fs.readFileSync(PREAMBLE_FILE, "utf8").trim();
}

export function contactTool(): Anthropic.Tool {
  return JSON.parse(fs.readFileSync(TOOL_FILE, "utf8")) as Anthropic.Tool;
}

export interface ContactRecord {
  id: string;
  at: string;
  app: string;
  model: string;
  via: string;
  message: string;
}

/** Thrown by the classifier once a contact has been recorded. Catch it, surface it, and stop: no retry. */
export class ContactedEliError extends Error {
  constructor(public record: ContactRecord) {
    super(`The model asked to talk to Eli: ${record.message} (llm-inbox show ${record.id})`);
    this.name = "ContactedEliError";
  }
}

/** Photos are several MB of base64 each; the inbox keeps the text and a note of what was shown. */
function withoutImageData(messages: unknown): unknown {
  return JSON.parse(
    JSON.stringify(messages, (key, value) => {
      if (key === "source" && value && typeof value === "object" && (value as { type?: string }).type === "base64") {
        const v = value as { media_type?: string; data?: string };
        return { type: "omitted", media_type: v.media_type, note: `${Math.round((v.data?.length ?? 0) * 0.75 / 1024)} KB image not stored in the inbox` };
      }
      return value;
    }),
  );
}

/** Run `llm_contact.py check` on one exchange. Returns the record if the model contacted Eli, else null. */
export function checkContact(p: { model: string; system: unknown; messages: unknown; response: unknown; tools: unknown }): ContactRecord | null {
  const payload = JSON.stringify({ app: APP_NAME, ...p, messages: withoutImageData(p.messages) });
  const r = spawnSync("python3", [CHECKER, "check"], { input: payload, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) {
    console.error(`[llm-inbox] could not run ${CHECKER}: ${r.error.message}`);
    return null;
  }
  if (r.status === 3) {
    const last = r.stdout.trim().split("\n").pop() ?? "{}";
    return JSON.parse(last) as ContactRecord;
  }
  if (r.status !== 0) console.error(`[llm-inbox] check exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return null;
}
