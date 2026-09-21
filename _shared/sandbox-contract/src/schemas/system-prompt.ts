// system-prompt: what a conversation was told before its own words
import { z } from "zod";
import { SystemPromptModeSchema } from "./settings.js";

// The prompt a turn runs on is composed from several places at once — the base, this product's guidance, the persona,
// the sandbox's field notes, the workspace's own rules — and none of it appears in the transcript. This is that
// composition, said back: what the last turn of a conversation was actually given.

// Which mechanism put a section into the prompt. The reader's question is never "what does paragraph nine say", it is
// "did my AGENTS.md arrive, are the field notes on", so every section names its own source.
export const PromptSectionSourceSchema = z.enum(["guidance", "persona", "field-notes", "memory"]);
export type PromptSectionSource = z.infer<typeof PromptSectionSourceSchema>;

export const PromptSectionSchema = z.object({
    source: PromptSectionSourceSchema.describe("Which mechanism added this."),
    title: z.string().describe("The one line a reader sees on the row that opens to the text below."),
    text: z.string().describe("The section's exact words, as the model received them."),
});
export type PromptSection = z.infer<typeof PromptSectionSchema>;

// intentic/claude/custom: a base whose text is knowable here (shipped, readable from the installed CLI, or the owner's
// own). runtime: a CLI that keeps its own prompt and only takes additions, so there is no text to show.
export const PromptBaseKindSchema = z.enum(["intentic", "claude", "custom", "runtime"]);
export type PromptBaseKind = z.infer<typeof PromptBaseKindSchema>;

export const PromptBaseSchema = z.object({
    kind: PromptBaseKindSchema.describe("Which prompt the additions ride on."),
    text: z
        .string()
        .optional()
        .describe("The base's own words, when they can be read here. Absent for a runtime that keeps its prompt to itself."),
});
export type PromptBase = z.infer<typeof PromptBaseSchema>;

// Recorded at dispatch, from the request the adapter was handed, so this is what was sent rather than what would be
// composed if the same turn were planned again now.
export const SystemPromptDisclosureSchema = z.object({
    at: z.number().describe("When the turn that was told this was sent (epoch ms)."),
    runtime: z.string().describe("Which runtime served that turn."),
    mode: SystemPromptModeSchema.describe("Which base the turn was configured to run on."),
    base: PromptBaseSchema,
    sections: z.array(PromptSectionSchema).describe("What the daemon added to that base, in the order the model reads them."),
});
export type SystemPromptDisclosure = z.infer<typeof SystemPromptDisclosureSchema>;

// Absent `prompt` is the honest answer for a conversation that has not dispatched a turn since the daemon started
// recording: nothing was composed, rather than nothing was added.
export const ConversationPromptSchema = z.object({
    prompt: SystemPromptDisclosureSchema.optional().describe("What the most recent turn of this conversation was told, if one has been recorded."),
});
export type ConversationPrompt = z.infer<typeof ConversationPromptSchema>;
