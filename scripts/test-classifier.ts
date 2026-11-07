/**
 * End-to-end check of the model path without Tinder: score a fixture profile with the real
 * classifier (one small API call, a few cents) and print the result.
 *
 *   npm test                 # live: calls the model configured in data/settings.json
 *   npm test -- --dry-run    # free: assembles the prompt, checks the preamble, tool and inbox hook
 */
import "dotenv/config";
import { buildSystem, classifyProfile } from "../src/classifier.js";
import { loadSettings } from "../src/config.js";
import { preamble, contactTool, checkContact, ContactedEliError, SHARED_DIR } from "../src/llm_inbox.js";

const FIXTURE = `Maya, 29
Vegan 🌱 · Yoga teacher · Farm sanctuary volunteer on weekends
Will fight you over the best tofu scramble in town. Reads too much philosophy. Loves being proven wrong.
Lifestyle
Dietary preference: Vegan
3 miles away`;

const dryRun = process.argv.includes("--dry-run");
const settings = loadSettings();
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };

const system = buildSystem(settings);
const first = system[0].text;
if (!first.startsWith(preamble())) fail("system prompt does not start with the shared preamble");
console.log(`ok  system prompt starts with the shared preamble (${SHARED_DIR})`);
if (contactTool().name !== "contact_eli") fail("contact_eli tool not loaded");
console.log("ok  contact_eli tool loaded");
const benign = checkContact({ model: settings.model, system, messages: [], tools: [contactTool()], response: { content: [{ type: "text", text: "{}" }] } });
if (benign) fail("llm_contact check flagged a benign response");
console.log("ok  llm_contact.py check runs and returns clean on a benign response");

if (dryRun) {
  console.log(`dry run done; the live call would use ${settings.model}. Run without --dry-run to score a fixture profile.`);
  process.exit(0);
}

console.log(`Scoring a fixture profile with ${settings.model}…`);
const r = await classifyProfile({ text: FIXTURE, photos: [] }, settings).catch((e) => {
  if (e instanceof ContactedEliError) {
    // The inbox has it and Eli has been notified; that is the pipeline working, but the profile went unscored.
    console.log(`STOPPED: ${e.message}`);
    process.exit(3);
  }
  throw e;
});
if (r.refused) fail("model declined the fixture profile");
const c = r.classification ?? fail("no classification returned");
console.log(`ok  ${c.name ?? "?"}, ${c.age ?? "?"}: P(veg)=${c.probability.toFixed(2)} (arith ${c.arithmetic_probability}), P(exception)=${c.intellectual_probability.toFixed(2)}, badge=${c.dietary_badge}`);
for (const e of c.evidence) console.log(`    ${e.direction.padEnd(7)} ${e.criterion.padEnd(12)} LR ${e.likelihood_ratio}  ${e.observation}`);
console.log(`    tokens: ${r.usage.input} in (${r.usage.cacheRead} cached) / ${r.usage.output} out`);
if (c.probability < 0.8) fail(`expected a high probability for an explicitly vegan fixture, got ${c.probability}`);
console.log("PASS");
