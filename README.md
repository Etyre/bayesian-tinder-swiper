# Tinder Swiper 🌱

A local web app that swipes Tinder for you, liking only women who are likely vegan, vegetarian, or otherwise not subsidizing factory farming. Each profile is scored by Claude with a Bayesian prompt: start from a base rate, update on the evidence in the bio, lifestyle badges, and photos, and swipe right only when the posterior clears your threshold (default 50%).

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

## Setup

```bash
npm install
cp .env.example .env   # then put your ANTHROPIC_API_KEY in .env
npm run dev
```

Open http://localhost:4747, press **Start batch (auto)** or **Review manually**, log into Tinder in the Chrome window that appears (phone-number login is the most reliable; Google login often refuses automated browsers), and profiles will start appearing in the dashboard.

If you don't have Google Chrome installed, switch "Browser" to *Bundled Chromium* in the settings panel and run `npx playwright install chromium` once.

## Settings (dashboard sidebar, stored in `data/settings.json`)

| Setting | Default | Meaning |
|---|---|---|
| Like threshold | 0.50 | Swipe right when P(meets criteria) ≥ this |
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

## What counts as evidence

The prompt (`src/prompt.ts`) spells this out. In short:

- **Near-decisive**: a Vegan/Vegetarian dietary badge, or the bio saying so outright.
- **Strong (LR ~5–30×)**: animal-rights activism, named vegan restaurants/foods, jokes that presume vegetarianism. Pescatarian badge lands around 0.6.
- **Moderate (LR ~2–4×)**: climate activism, flexitarian/"mostly plant-based" (still short of the criterion), "only eat meat I know the source of".
- **Weak (LR ~1.2–2×, correlated)**: yoga, hiking, loves animals, crunchy aesthetic, progressive signals. Three of these together count as ~2–3× total, not 8×.
- **Against**: Omnivore/Carnivore/Kosher/Halal badge, meat in bio or photos, "must love steak".
- Body type and "looking healthy" are explicitly excluded as evidence.

Tune the prior to your city: 0.10 is reasonable for a large US coastal city, lower in most other places.

## Caveats

- **Tinder's terms forbid automation.** Accounts running bots can be shadowbanned or banned. The app uses your real Chrome, random delays, and a session cap to look human, but the risk is real. Keep sessions modest.
- Tinder's web DOM changes without notice. Scraping is heuristic (ARIA labels, structure) and the model gets a screenshot as backup, but if profiles stop being detected, check `data/errors/` for screenshots and adjust `cardInfoInPage` in `src/tinder.ts`.
- Cost: roughly 3–8k input tokens per profile with 5 photos on Opus 5, so on the order of a few cents per profile. The system prompt is cached.
- Profiles the model declines to evaluate are recorded as "skipped" and swiped left in auto mode, since you only want likes on qualifying profiles.
