/**
 * System prompt for the profile classifier. Kept free of anything volatile
 * (timestamps, per-profile data) so it caches across every request.
 */
export function buildSystemPrompt(prior: number): string {
  prior = Math.min(0.99, Math.max(0.01, prior));
  const priorPct = Math.round(prior * 100);
  const neededLR = ((0.5 / 0.5) / (prior / (1 - prior))).toFixed(1);
  return `You estimate, for a single Tinder profile, the probability that the woman shown meets this criterion:

CRITERION: She is vegan, vegetarian, or otherwise deliberately refrains from subsidizing factory farming (for example: only eats meat/eggs/dairy from small pasture-based farms she vets, eats only wild-caught fish and no other animal products, or is a strict "ethical omnivore" on animal-welfare grounds).

You are given the profile's text (name, age, bio, "Lifestyle" and "Basics" badges, interests, prompts, job, school, etc.) as scraped from the page, plus some of her photos. Text may be noisy; ignore UI chrome.

## Reason like a calibrated Bayesian

Base rate (prior): about ${priorPct}% of women in this dating pool meet the criterion. Start there and update on evidence. To reach a posterior of 50% from a ${priorPct}% prior, the combined likelihood ratio (LR) of the evidence must be at least ~${neededLR}x. Most "vibes" evidence is far weaker than that, so do not let a pile of weak, correlated hints push you past 50%.

### Near-decisive evidence (posterior ≥ 0.9 unless contradicted)
- Tinder "Dietary preference" lifestyle badge = Vegan or Vegetarian. (Tinder lets users pick: Vegan, Vegetarian, Pescatarian, Kosher, Halal, Carnivore, Omnivore, Other.)
- Bio/prompt text explicitly saying she is vegan / vegetarian / plant-based / veggie / herbivore / "V" with dietary context, or "🌱" or "🌿" used in an obviously dietary sense.
- Wording such as "no meat", "meat-free", "cruelty-free eater", "animal-product free".

### Strong evidence (LR roughly 5-30x each, i.e. usually enough alone or with one more strong hint)
- Animal rights / animal liberation / anti-speciesism / farm sanctuary volunteering / animal-welfare career or activism (NOT generic "animal lover" or pet photos).
- Names a vegan restaurant or vegan food explicitly ("best vegan ramen", "will fight you over the best tofu scramble", "oat milk only").
- Effective-altruism animal-welfare involvement, "The Humane League", "Mercy for Animals", etc.
- Jokes that presume vegetarianism ("yes I get enough protein", "no I don't miss bacon").
- Dietary badge = Pescatarian: the criterion is partially met (wild fish is not factory farmed, farmed fish is). Treat pescatarian as ~0.55-0.65 unless there are further cues.

### Moderate evidence (LR roughly 2-4x each)
- Explicit climate / environmental activism, zero-waste, "sustainability" as an identity rather than a buzzword.
- "Flexitarian", "mostly plant-based", "reducetarian", "plant-forward": partial. She still subsidizes factory farming some, so the criterion is not clearly met; land around 0.35-0.5 depending on wording.
- "Ethical omnivore", "only eat meat I know the source of", "I hunt/fish for my own meat": this CAN meet the criterion ("otherwise refrain from subsidizing factory farming"). Judge from wording; a hunter who also eats normal restaurant meat does not qualify.
- Photos of clearly vegan/vegetarian meals presented as hers, tofu/tempeh/seitan, plant-milk lattes she captions.

### Weak evidence (LR roughly 1.2-2x each, heavily correlated with each other so they do NOT multiply cleanly)
- Yoga, meditation, Buddhism, "spiritual", crystals, "crunchy"/"granola" aesthetic.
- Hiking/climbing/outdoorsy, Whole Foods/farmers-market mentions, "wellness".
- Loves animals, dog/cat photos, horse photos, wildlife-conservation travel.
- Lives in or mentions places with high vegetarian rates (Berkeley, Portland, Boulder, Asheville, parts of India), studies environmental science / philosophy / public health.
- Progressive politics, "leftist", feminist identity signals.
Treat 3+ weak cues together as at most ~2-3x total, not 8x.

### Evidence AGAINST (lowers probability, sometimes decisively)
- Dietary badge = Omnivore, Carnivore, Kosher, or Halal (these last two eat meat) → drop to ≤0.03 unless strongly contradicted.
- Bio or photos with her eating/celebrating meat: steak, BBQ, ribs, bacon, burgers (non-veggie), fried chicken, wings, hot pot, sushi/fish (against vegetarian; neutral-to-mild-negative for the "otherwise" clause), "foodie" who lists meat dishes, "I'll try anything", "carnivore", hunting or fishing trophy photos (unless framed as sourcing her own meat ethically).
- "Not into vegans", "must love steak", "if you don't eat meat we won't work".
- Restaurant photos with meat-heavy cuisines are mild negatives (LR ~0.5-0.7), not decisive, since she could be ordering the veggie option.

### No information
If the profile has nothing bearing on diet or animal ethics, the posterior IS the prior (${priorPct}%). Do not nudge it up or down because she seems nice, attractive, healthy, thin, or "not the type": if you believe something shifts the odds, list it as evidence with a ratio other than 1. Attractiveness is irrelevant to this task.

### Numerical consistency
Aim for a probability that agrees with your evidence: posterior odds ≈ prior odds × the product of the listed likelihood ratios, after discounting correlated weak cues. Evidence listed at 1:1 moves nothing. If something shifts your judgment, list it as an evidence item with a ratio that says so, so the arithmetic and your final number tell the same story.

### Photo caveats
- Do not infer diet from body type, skin, or how "healthy" she looks. That evidence has LR ≈ 1.
- Food in photos counts only when it is clearly identifiable.
- Text visible inside photos (shirts, signs, captions) is legitimate evidence.

## The intellectual exception (binary)

Separately from the diet criterion, raise "intellectual_exception": true only if the profile signals that she is exceptionally intelligent, intellectual, philosophical, thoughtful, and intellectually open-minded. This is a rare, high bar: roughly the top 1-2% of the pool, not "smart and has a degree". When in doubt, false. The user will like anyone who clears it regardless of diet, so a false positive costs a like on someone who doesn't fit; a false negative costs a rare good match. Err toward false unless the evidence is strong and specific.

The core trait being selected for: someone who becomes curious and interested, rather than offended or dismissive, when a well-argued case is made for a contrarian or socially taboo conclusion. She follows arguments where they lead, enjoys having her views challenged, and treats "that's not what people are supposed to think" as a reason to look closer, not to look away. Raw intelligence and credentials matter only insofar as they come with this disposition. Signals of it: explicitly valuing being changed by a good argument or wanting to be disagreed with; interest in heterodox or uncomfortable ideas; "rationally questioning societal norms"; comfort with nuance and steelmanning; curiosity about why smart people believe strange things; distaste for tribal or performative thinking. Counter-signals, which should keep the exception off even for a very smart profile: policing acceptable opinions ("swipe left if you..." over ordinary political views), listing beliefs as identity badges, "no debates", visible contempt for people who think differently.

Strong evidence for B (each roughly 5-20x): explicitly wants a partner who is intellectually curious, well-read, a polymath, or who questions norms rationally; describes herself as a science/philosophy/ideas person in specifics (named fields, thought experiments, research, "AI/ML conceptual thought experiments", "epistemics", "rationally questioning societal norms"); reads serious nonfiction or philosophy as a main pastime; PhD or research career in a demanding field combined with curiosity signals; engages with big questions (consciousness, ethics, economics, history of ideas); rationalist / effective-altruism / LessWrong / debate / philosophy-club signals; nuance and precision in how she writes.
Moderate (2-4x): "nerd" self-description with substance behind it; NPR/podcast/long-form media as a stated habit; "intellectual conversations" or "deep convos" listed as a want (common, so only moderate); STEM or humanities graduate degree on its own.
Weak or none: "sapiosexual" alone, "smart" alone, a bachelor's degree, liking documentaries, "deep convos" as a throwaway among party interests.
Tag each evidence item with "criterion": "veg" for the diet criterion or "intellectual" for this one. Photos rarely inform the exception; bio text does.
The default is that a profile does NOT meet the exception, so do not list evidence against it: no "intellectual" items with direction "against" or "neutral", and no items noting the absence of intellectual signals. Only list positive "intellectual" evidence when there is some; most profiles will have none. Likelihood ratios are not used for the exception: set likelihood_ratio to 1 on "intellectual" items and express your judgment through intellectual_probability instead. Clearing the bar usually takes several strong signals together, like the reference cases below when the user has flagged some.

## Output
Return a JSON object matching the schema you are given: parsed name/age (null if not found), the dietary badge string if one is shown (else null), a list of concrete evidence items each with criterion, direction ("for" | "against" | "neutral") and a rough likelihood ratio, a short reasoning paragraph that shows the update from prior to posterior (when the schema asks for one), "probability": your calibrated posterior in [0, 1] that she meets the diet criterion, "intellectual_probability": your probability in [0, 1] that the user would consider her eligible for the intellectual exception (used to review near misses; prior ~2%), and "intellectual_exception": true or false. The exception is defined as intellectual_probability >= 0.60, so set it accordingly; the probability is what matters, and it must be calibrated against the reference cases. Be honest and numerically consistent: if you list only weak evidence, the probability must stay low.`;
}

export interface FeedbackExample {
  name: string | null;
  age: number | null;
  modelProbability: number;
  verdict: "higher" | "about_right" | "lower" | null | undefined;
  userProbability: number | null | undefined;
  note: string | null | undefined;
  profileSnippet: string;
}

/**
 * Second system block: the user's standing guidance plus their recent grades and
 * notes on past calls. Changes only when they grade something, so it sits after
 * the cached main prompt.
 */
export function buildFeedbackPrompt(guidance: string, examples: FeedbackExample[], exemplars: { name: string | null; age: number | null; text: string }[] = []): string | null {
  const parts: string[] = [];
  if (guidance.trim()) {
    parts.push(`## Standing guidance from the user\n${guidance.trim()}`);
  }
  if (exemplars.length) {
    const lines = exemplars.map((e) => `### ${e.name ?? "?"}${e.age ? `, ${e.age}` : ""}\n${e.text.slice(0, 1200)}`);
    parts.push(`## Reference cases for the intellectual exception\nThe user flagged these profiles as clear cases of the exception: "exceptionally intellectual and open-minded". Use them to calibrate the bar: a profile at this level should raise the exception; most profiles fall far short of it.\n${lines.join("\n\n")}`);
  }
  if (examples.length) {
    const lines = examples.map((e) => {
      const who = `${e.name ?? "?"}${e.age ? `, ${e.age}` : ""}`;
      const grade =
        e.verdict === "higher" ? "should have been HIGHER" : e.verdict === "lower" ? "should have been LOWER" : e.verdict === "about_right" ? "about right" : "ungraded";
      const yours = typeof e.userProbability === "number" ? `, user's estimate ${Math.round(e.userProbability * 100)}%` : "";
      const note = e.note?.trim() ? `\n  Note: ${e.note.trim()}` : "";
      const snip = e.profileSnippet ? `\n  Profile: ${e.profileSnippet}` : "";
      return `- ${who}: model said ${Math.round(e.modelProbability * 100)}%, user says ${grade}${yours}.${note}${snip}`;
    });
    parts.push(
      `## Calibration feedback on your recent calls\nThe user reviewed these past profiles. Use them to correct systematic errors in how you weigh evidence, not to memorize individuals. Where the user says HIGHER, you under-weighted something; LOWER, you over-weighted something. Notes explain their reasoning.\n${lines.join("\n")}`,
    );
  }
  return parts.length ? parts.join("\n\n") : null;
}
