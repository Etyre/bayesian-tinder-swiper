import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { buildSystemPrompt, buildFeedbackPrompt } from "./prompt.js";
import { feedbackExamples } from "./store.js";
import type { Settings } from "./config.js";

export const ClassificationSchema = z.object({
  name: z.string().nullable(),
  age: z.number().int().nullable(),
  dietary_badge: z.string().nullable(),
  evidence: z.array(
    z.object({
      observation: z.string(),
      direction: z.enum(["for", "against", "neutral"]),
      likelihood_ratio: z.number(),
    }),
  ),
  reasoning: z.string(),
  probability: z.number().min(0).max(1),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export interface ProfileInput {
  text: string;
  photos: { data: Buffer; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" }[];
  screenshot?: Buffer; // PNG of the opened profile
}

export interface ClassifyResult {
  classification: Classification | null;
  refused: boolean;
  usage: { input: number; output: number; cacheRead: number };
}

const client = new Anthropic();

export async function classifyProfile(profile: ProfileInput, settings: Settings): Promise<ClassifyResult> {
  const content: Anthropic.ContentBlockParam[] = [];

  content.push({
    type: "text",
    text: `PROFILE TEXT (scraped from the page; may include UI noise):\n\n${profile.text.slice(0, 12_000)}`,
  });

  if (profile.screenshot) {
    content.push({ type: "text", text: "Screenshot of the opened profile (shows badges and layout):" });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: profile.screenshot.toString("base64") },
    });
  }

  profile.photos.forEach((p, i) => {
    content.push({ type: "text", text: `Photo ${i + 1}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: p.mediaType, data: p.data.toString("base64") },
    });
  });

  content.push({
    type: "text",
    text: "Estimate the probability that this woman meets the criterion. Follow the Bayesian procedure and return the JSON object.",
  });

  // Haiku 4.5 predates adaptive thinking and the effort parameter; every other
  // offered model (Opus 5, Sonnet 5, Opus 4.8, Fable 5.1) takes both.
  const isHaiku = /haiku/i.test(settings.model);
  // Stable prompt first (cached), then the user's guidance and graded examples, which change rarely.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildSystemPrompt(settings.prior), cache_control: { type: "ephemeral" } },
  ];
  const feedback = buildFeedbackPrompt(
    settings.userGuidance,
    feedbackExamples(40).map((d) => ({
      name: d.name,
      age: d.age,
      modelProbability: d.classification!.probability,
      verdict: d.verdict,
      userProbability: d.userProbability,
      note: d.note,
      profileSnippet: (d.profileText ?? "").replace(/\s+/g, " ").slice(0, 220),
    })),
  );
  if (feedback) system.push({ type: "text", text: feedback });

  const response = await client.messages.parse({
    model: settings.model,
    max_tokens: 4000,
    ...(isHaiku ? {} : { thinking: { type: "adaptive" as const } }),
    output_config: { ...(isHaiku ? {} : { effort: settings.effort }), format: zodOutputFormat(ClassificationSchema) },
    system,
    messages: [{ role: "user", content }],
  });

  const usage = {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
  };

  if (response.stop_reason === "refusal") {
    return { classification: null, refused: true, usage };
  }
  return { classification: response.parsed_output ?? null, refused: false, usage };
}
