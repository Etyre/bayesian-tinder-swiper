# Tinder Swiper 🌱

A local web app that swipes Tinder for you, liking only women who are likely vegan, vegetarian, or otherwise not subsidizing factory farming. Each profile is scored by Claude with a Bayesian prompt: start from a base rate, update on the evidence in the bio, lifestyle badges, and photos, and swipe right only when the posterior clears your threshold (default 50%). Built 2026-09-03 because swiping by hand for a narrow criterion is slow and the criterion is mostly legible from the profile; wired to the shared LLM inbox on 2026-11-07.

## How it works

1. Playwright opens Google Chrome with its own persistent profile in `data/browser-profile/`, with the dashboard in the first tab and Tinder in the second. You log into Tinder by hand the first time; the session is remembered.
2. **Start batch (auto)** runs one swiping session of random length (10–150 minutes by default), like a person picking up the app for a while. For each card it opens the profile and sends the text (bio, Lifestyle badges such as Dietary Preference, interests, prompts) plus the first photo and a screenshot to Claude with a structured-output schema. If that first score is under the quick-pass threshold (15%), it passes right away. Otherwise it looks through every photo and re-scores with the full set.
3. The model returns evidence items with rough likelihood ratios, a reasoning paragraph, and a calibrated probability. The app swipes right if the probability clears your threshold (default 50%), else left, with human-like pauses, photo flipping, and bio scrolling in between.
4. The batch ends when its time is up, Tinder runs out of profiles or likes, or the swipe cap is hit. Optionally it takes a random break (default 1.5–6 hours, within active hours) and starts the next batch itself.
5. Afterwards, the **Review** tab shows every profile it judged. Filter by "probability ≥ X", by the model's call, your swipe, or your grade. Grade each call as **Lower probability**, **No change**, or **Higher probability**, drag the "Your estimate" slider to give your own probability, and leave a note on what the model missed. Your notes and grades, plus the standing "Guidance for the model" box in settings, are included in every future prompt as calibration feedback, so the model learns your judgment over time. The sidebar tallies the grades and shows the model's average bias against your estimates, which tells you whether to move the threshold or prior.

**Review manually** is the alternative flow: the model scores the card on screen and waits for you to press Pass or Like in the dashboard (or the arrow keys), which performs the real swipe. Your swipe is graded automatically: liking against a pass recommendation counts as "should be higher", and so on.

Every decision is appended to `data/decisions.jsonl`.

### Safety rails

All clicks and keypresses are gated on the browser being at `tinder.com/app/recs` (or the opened-card view at `/app/recs/profile`). If the page drifts anywhere else, the app navigates straight back by URL without clicking anything, and gives up the batch if it can't. Selectors are scoped to the active card, popup dismissal only matches Tinder's own upsell labels inside dialogs, and the app never reads or touches your own profile, matches, or settings pages.

### The model call and the LLM inbox

There is one call site, `classifyProfile` in `src/classifier.ts`, used by the batch loop (once or twice per profile) and by `scripts/scan-intellectual.ts`. Every call follows the shared standard in `../CLAUDE.md`:

- The system prompt starts with `../shared/llm-system-prompt-preamble.md`, read from disk on every call (so an edit applies without a restart), followed by the classifier prompt from `src/prompt.ts` and then the feedback block. The first block carries `cache_control` so the stable prefix is cached.
- The `contact_eli` tool from `../shared/contact_eli_tool.json` is on every call, next to the JSON output schema.
- After each response, `src/llm_inbox.ts` pipes `{app, model, system, messages, response, tools}` to `python3 ../shared/llm_contact.py check`. Exit 3 means the model contacted Eli: the record is in the inbox, Eli has been notified, and `classifyProfile` throws `ContactedEliError`. The batch loop records the profile as "skipped" with the message as its error, ends the batch with status **error** (so continuous mode does not schedule another), and `scan-intellectual` exits 3. Nothing retries. Read and answer with `llm-inbox`.

### Settings (dashboard sidebar, stored in `data/settings.json`)

| Setting | Default | Meaning |
|---|---|---|
| Like threshold | 0.50 | Swipe right when P(meets criteria) ≥ this |
| Intellectual exception | on | If the model's probability that a profile is exceptionally intelligent, intellectual, philosophical, thoughtful and open-minded reaches 60%, it's a like regardless of diet. Flag reference cases on cards with 🧠 to calibrate the model |
| Super like | on | Profiles at or above the super-like threshold (default 0.90) get a super like instead of a like. Falls back to a like when Tinder has none left |
| Prior | 0.10 | Base rate of qualifying women in your pool. With a 10% prior the evidence needs a combined likelihood ratio of ~9× to reach 50% |
| Batch length | 10–150 min | Random session length per batch |
| After a batch | stop | Or take a random break (90–360 min) and start the next batch, only within active hours (9:00–23:00) |
| Max swipes / batch | 100 | Hard stop per batch |
| Delay between swipes | 2.5–7 s | Random pause after each swipe |
| Browse like a human | on | Flips photos with uneven pauses, occasional double-take, scrolls the bio, rare 12–40 s pause. Before liking or super liking, it looks through every photo with long pauses and usually re-reads the bio, saving any photos it hadn't captured to the card |
| Quick pass below | 15% | Two-stage judging. Stage one scores the bio and the photo already showing; below this it passes right away. Otherwise it looks at every photo and re-scores with the full set |
| Max photos sent to model | 5 | Cap when it does flip through |
| Window | visible | Headless runs without a window. Login always gets a visible window; a real window is slightly harder to fingerprint as a bot |
| Written reasoning | off | On adds a reasoning paragraph to each card at the cost of a couple of seconds per profile. The evidence list is always captured |
| Model / effort | claude-opus-5 / medium | Dropdown: Opus 5, Sonnet 5, Haiku 4.5, Opus 4.8, Fable 5.1. Raise effort for harder judgment calls, lower for cost |

Everything you type in the dashboard (the guidance box and other settings before you press Save, a card's note, a "Your estimate" number) is mirrored to the browser's `localStorage` as you type and restored when the page loads, so a reload or crash never loses a draft. A draft is cleared only once the server has accepted it.

### What counts as evidence

The prompt (`src/prompt.ts`) spells this out. In short:

- **Near-decisive**: a Vegan/Vegetarian dietary badge, or the bio saying so outright.
- **Strong (LR ~5–30×)**: animal-rights activism, named vegan restaurants/foods, jokes that presume vegetarianism. Pescatarian badge lands around 0.6.
- **Moderate (LR ~2–4×)**: climate activism, flexitarian/"mostly plant-based" (still short of the criterion), "only eat meat I know the source of".
- **Weak (LR ~1.2–2×, correlated)**: yoga, hiking, loves animals, crunchy aesthetic, progressive signals. Three of these together count as ~2–3× total, not 8×.
- **Against**: Omnivore/Carnivore/Kosher/Halal badge, meat in bio or photos, "must love steak".
- Body type and "looking healthy" are explicitly excluded as evidence.

Tune the prior to your city: 0.10 is reasonable for a large US coastal city, lower in most other places.

## Files

| File | Purpose |
|---|---|
| `src/server.ts` | Entry point. Express dashboard on `PORT` (default 4747): static files, REST API, server-sent events, thumbnail generation |
| `src/swiper.ts` | The batch loop: launches the browser, scrapes each card, calls the classifier (two stages), swipes or waits for you, schedules the next batch |
| `src/tinder.ts` | Playwright driver for Tinder's web app: launch, login detection, scraping, photo flipping, swiping, popup dismissal, error screenshots |
| `src/classifier.ts` | The single model call site: builds the system prompt (preamble + prompt + feedback), structured-output schemas, the arithmetic posterior, the contact check |
| `src/prompt.ts` | The Bayesian classifier prompt and the feedback block (your guidance, graded examples, reference cases) |
| `src/llm_inbox.ts` | Glue to `../shared`: reads the preamble and `contact_eli` tool, runs `llm_contact.py check`, defines `ContactedEliError` |
| `src/store.ts` | `data/decisions.jsonl` read/write, verdicts, notes, stats, feedback examples |
| `src/config.ts` | Settings schema (zod) and `data/settings.json` load/save |
| `src/paths.ts` | Project paths; creates the `data/` folders on import |
| `public/index.html`, `public/app.js`, `public/style.css` | The dashboard: Live tab (settings, log, current card, recent) and Review tab (filters, grading, notes) |
| `scripts/test-classifier.ts` | `npm test`: proves the model path end to end on a fixture profile; `--dry-run` checks the wiring for free |
| `scripts/scan-intellectual.ts` | `npm run scan`: re-scores already-collected profiles for the intellectual exception (text only) |
| `.env.example` | Template for `.env` (`ANTHROPIC_API_KEY`, `PORT`) |
| `package.json`, `tsconfig.json` | Node/TypeScript project; run with `tsx`, no build step |

Dependencies, and why: `playwright` drives Chrome; `@anthropic-ai/sdk` + `zod` give structured output with a typed schema; `express` serves the dashboard; `sharp` makes thumbnails (full-size photos were eating browser memory); `dotenv` loads `.env`.

## Runtime locations

- Config: `.env` in this folder (API key, port; untracked, template in `.env.example`) and `data/settings.json` (everything in the dashboard sidebar).
- State: `data/decisions.jsonl` (every decision, append-only; `data/decisions.backup.jsonl` is an early backup), `data/photos/<decision id>/` (saved photos and thumbnails), `data/browser-profile/` (the Chrome profile with your Tinder session, about 1.3 GB), `data/errors/` (screenshots when a card is not found or the loop crashes). `data/` is gitignored.
- Logs: the terminal that ran `npm run dev` (also mirrored into the dashboard's Log panel, last 200 lines). There is no log file; see Common tasks for how to keep one.
- LLM inbox: records in `~/Library/Application Support/LLMInbox/messages.jsonl`, log in `~/Library/Logs/llm-inbox.log`, shared code in `../shared/`.
- Installed copy: none. It runs from this folder on demand; nothing is under launchd.

## Common tasks

```bash
npm install                         # once; also after pulling dependency changes
cp .env.example .env                # then put your ANTHROPIC_API_KEY in .env (or `ant auth login` and leave it unset)
npm run dev                         # dashboard at http://localhost:4747, restarts on source changes
npm start                           # same without the file watcher
npm run typecheck                   # tsc --noEmit
npm test -- --dry-run               # free: preamble, contact_eli tool and llm_contact.py hook all wired
npm test                            # one real model call on a fixture vegan profile; prints P, evidence, tokens; PASS/FAIL/STOPPED
npm run scan -- 40                  # re-score up to 40 collected profiles for the intellectual exception (text only)
npm run dev 2>&1 | tee -a ~/Library/Logs/tinder-swiper.log   # if you want a log file
curl -s 'http://localhost:4747/api/debug/inspect?open=1' | jq .   # dump what the scraper sees on the current card
llm-inbox list                      # messages the model sent to Eli; `llm-inbox show <id>` / `debrief <id>`
```

Open http://localhost:4747, press **Start batch (auto)** or **Review manually**, log into Tinder in the Chrome window that appears (phone-number login is the most reliable; Google login often refuses automated browsers), and profiles will start appearing in the dashboard. Stop with the **Stop** button or Ctrl-C in the terminal (which also closes the browser).

If you don't have Google Chrome installed, switch "Browser" to *Bundled Chromium* in the settings panel and run `npx playwright install chromium` once.

## Settings that matter

- Google Chrome installed (the default browser channel), or Bundled Chromium as above.
- A Tinder account logged in by hand the first time in the Playwright window; the session lives in `data/browser-profile/`.
- `ANTHROPIC_API_KEY` in `.env`, or an `ant auth login` profile.
- The LLM inbox needs `python3` on PATH and `../shared/` next to this folder (`~/Library/Application Support/LLMInbox/config.env` holds the email/ntfy settings; see `../shared/README.md`).
- nightblock closes `api.anthropic.com` from midnight to 6am. Continuous mode only starts batches inside the active hours (default 9:00–23:00), but a long batch that runs past midnight will see classifier errors until morning.

## Gotchas learned

- **Tinder's terms forbid automation.** Accounts running bots can be shadowbanned or banned. The app uses your real Chrome, random delays, and a session cap to look human, but the risk is real. Keep sessions modest.
- Tinder's web DOM changes without notice. Scraping is heuristic (ARIA labels, structure) and the model gets a screenshot as backup, but if profiles stop being detected, check `data/errors/` for screenshots and adjust `cardInfoInPage` in `src/tinder.ts`.
- Cost: roughly 3–8k input tokens per profile with 5 photos on Opus 5, so on the order of a few cents per profile. The system prompt is cached.
- Profiles the model declines to evaluate are recorded as "skipped" and swiped left in auto mode, since you only want likes on qualifying profiles.
- Google login often refuses automated browsers; phone-number login works.
- `loadSettings()` falls back to defaults and **overwrites** `data/settings.json` if the file fails the zod schema. Raising a value past the schema's max (as happened with the swipe cap) silently resets every setting. Widen the schema in `src/config.ts` and the matching `max` in `public/index.html` together.
- On the first live `npm test`, Haiku 4.5 used `contact_eli` to ask whether it was supposed to use the tool, which stopped the run (correctly) with a spurious message. The Output section of the prompt now says the normal response is the JSON object and the tool is only for when the model itself wants Eli; the next run scored normally. If a model starts contacting Eli on every profile, that sentence in `src/prompt.ts` is the place to look.
- Under structured output the response is one JSON block, so the preamble's `@ELI:` line marker cannot appear at the start of a line; the `contact_eli` tool is the live channel. `llm_contact.py` still scans text blocks, so it would catch a marker if the model ever answered outside the schema.
- Photos are several MB of base64 each, so `src/llm_inbox.ts` replaces image data with a size note before writing the inbox record. The debrief sees the profile text, not the pictures.
- A contact ends the batch with status **error** and no next batch is scheduled. After answering in `llm-inbox`, press Start again.
