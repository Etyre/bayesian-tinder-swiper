/**
 * Score already-collected profiles for the intellectual criterion (text only) and
 * print the top candidates. Keyword screen first, then the model on the shortlist.
 *
 *   npx tsx scripts/scan-intellectual.ts [maxToScore]
 */
import "dotenv/config";
import { readDecisions } from "../src/store.js";
import { classifyProfile } from "../src/classifier.js";
import { loadSettings } from "../src/config.js";

const KEYWORDS = /philosoph|physic|math|scien|research|phd|professor|academi|book|read|novel|nerd|curious|curiosity|intellect|thought experiment|epistem|rational|debate|econom|history|linguist|neuro|engineer|polymath|ideas|existential|stoic|nietzsche|kant|sartre|camus|dostoevsky|poetry|writer|writing|journal|npr|podcast|lecture|learn|question|consciousness|ethic|effective altruism|lesswrong|ai |machine learning|astrophys|biolog|chemist|cognitive|psycholog|anthropolog|sociolog|political|theory|thinker|deep conv|grad school|masters|master's|dissertation|thesis/i;

const max = parseInt(process.argv[2] ?? "40", 10);
const settings = loadSettings();
const all = readDecisions(100_000).filter((d) => d.profileText && d.profileText.length > 60);
const seen = new Set<string>();
const uniq = all.filter((d) => { const k = `${d.name}|${d.age}`; if (seen.has(k)) return false; seen.add(k); return true; });
const shortlist = uniq
  .map((d) => ({ d, hits: (d.profileText!.match(new RegExp(KEYWORDS.source, "gi")) ?? []).length }))
  .filter((x) => x.hits > 0)
  .sort((a, b) => b.hits - a.hits)
  .slice(0, max);

console.log(`${uniq.length} unique profiles with text; ${shortlist.length} pass the keyword screen. Scoring with ${settings.model}…`);
const results: { name: string; age: number | null; exception: boolean; pVeg: number; hits: number; id: string; top: string }[] = [];
for (const { d, hits } of shortlist) {
  try {
    const r = await classifyProfile({ text: d.profileText!, photos: [] }, settings);
    const c = r.classification;
    if (!c) continue;
    const top = c.evidence.filter((e) => e.criterion === "intellectual" && e.direction === "for").map((e) => e.observation).slice(0, 2).join("; ");
    results.push({ name: d.name ?? "?", age: d.age, exception: c.intellectual_exception, pVeg: c.probability, hits, id: d.id, top });
    process.stdout.write(".");
  } catch (e) {
    process.stdout.write("x");
  }
}
console.log("\n");
const raised = results.filter((r) => r.exception);
console.log(`Exception raised for ${raised.length} of ${results.length} scored:`);
for (const r of raised) console.log(`  🧠 ${r.name}, ${r.age ?? "?"}  (veg ${(r.pVeg * 100).toFixed(0)}%)  ${r.top}`);
console.log("\nNear misses (evidence for, but no exception):");
for (const r of results.filter((r) => !r.exception && r.top).slice(0, 8)) console.log(`     ${r.name}, ${r.age ?? "?"}  ${r.top}`);
