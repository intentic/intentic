// system-prompt: what a conversation was told before its own words
import { z } from "zod";
import { SystemPromptModeSchema } from "./settings.js";

// Every section names its mechanism: the reader asks "did my AGENTS.md arrive", not "what does paragraph nine say".
export const PromptSectionSourceSchema = z.enum(["guidance", "persona", "field-notes", "memory"]);
export type PromptSectionSource = z.infer<typeof PromptSectionSourceSchema>;

export const PromptSectionSchema = z.object({
    source: PromptSectionSourceSchema.describe("Which mechanism added this."),
    title: z.string().describe("The one line a reader sees on the row that opens to the text below."),
    text: z.string().describe("The section's exact words, as the model received them."),
});
export type PromptSection = z.infer<typeof PromptSectionSchema>;

// `runtime`: a CLI that keeps its own prompt, so no text; `trimmed`: the small-window paragraph, never reported as `custom`.
export const PromptBaseKindSchema = z.enum(["intentic", "claude", "custom", "runtime", "trimmed"]);
export type PromptBaseKind = z.infer<typeof PromptBaseKindSchema>;

export const PromptBaseSchema = z.object({
    kind: PromptBaseKindSchema.describe("Which prompt the additions ride on."),
    text: z.string().optional().describe("The base's own words, when they can be read here. Absent for a runtime that keeps its prompt to itself."),
});
export type PromptBase = z.infer<typeof PromptBaseSchema>;

// Recorded at dispatch from the request the adapter was handed: what was sent, not what would be composed now.
export const SystemPromptDisclosureSchema = z.object({
    at: z.number().describe("When the turn that was told this was sent (epoch ms)."),
    runtime: z.string().describe("Which runtime served that turn."),
    mode: SystemPromptModeSchema.describe("Which base the turn was configured to run on."),
    base: PromptBaseSchema,
    sections: z.array(PromptSectionSchema).describe("What the daemon added to that base, in the order the model reads them."),
});
export type SystemPromptDisclosure = z.infer<typeof SystemPromptDisclosureSchema>;

// Absent `prompt` means no turn was dispatched since the daemon started recording.
export const ConversationPromptSchema = z.object({
    prompt: SystemPromptDisclosureSchema.optional().describe("What the most recent turn of this conversation was told, if one has been recorded."),
});
export type ConversationPrompt = z.infer<typeof ConversationPromptSchema>;
