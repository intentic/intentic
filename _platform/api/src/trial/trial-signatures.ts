// Gemini 3 and later check a thought signature on the first function call of every model step in the current turn, and
// refuse a request whose call has none with a 400. Google hands the signature out on the call itself (on its
// OpenAI-compatible surface, `tool_calls[].extra_content.google.thought_signature`), but the sandbox's translator rebuilds
// each request from Anthropic-shaped turns and drops it, so every trial turn that used a tool was refused at its second
// step (2026-11-10: every new account's first trial message, for a week). Where a call's own signature is gone, Google's
// documented stand-in skips the check for that call; a signature that did survive is left as it came.
import { parseJsonOr } from "@intentic/base/json";
import { z } from "zod";

export const SKIPPED_SIGNATURE = `skip_thought_signature_validator`;

// Google's OpenAI-compatible surface is the one under `/openai` (trial-ladder.ts reads its native listing off the same
// address). Any other upstream gets the body untouched: OpenAI's own API refuses a field it does not know.
export const googleCompatible = (baseUrl: string): boolean => baseUrl.replace(/\/+$/, ``).endsWith(`/openai`);

// Loose throughout: only the fields read here are named, and every other one rides through the rewrite as it came.
const googleExtraSchema = z.looseObject({ thought_signature: z.string().optional() });
const extraContentSchema = z.looseObject({ google: googleExtraSchema.optional() });
const toolCallSchema = z.looseObject({ extra_content: extraContentSchema.optional() });
const assistantStepSchema = z.looseObject({ role: z.literal(`assistant`), tool_calls: z.array(z.unknown()).min(1) });
const chatBodySchema = z.looseObject({ messages: z.array(z.unknown()) });

type ToolCall = z.infer<typeof toolCallSchema>;

const signed = (call: ToolCall): ToolCall => ({
    ...call,
    extra_content: { ...call.extra_content, google: { ...call.extra_content?.google, thought_signature: SKIPPED_SIGNATURE } },
});

/** Every assistant step that called a tool, its first call signed. Undefined where none needed it. */
export const signedToolCalls = (messages: readonly unknown[]): unknown[] | undefined => {
    const rewritten = messages.map((entry) => {
        const step = assistantStepSchema.safeParse(entry);
        // The first call of a step is the one Google signs (and checks); the calls after it in the same step carry none.
        const first = step.success ? toolCallSchema.safeParse(step.data.tool_calls[0]) : undefined;
        if (!step.success || first?.success !== true || (first.data.extra_content?.google?.thought_signature ?? ``) !== ``) {
            return entry;
        }
        return { ...step.data, tool_calls: [signed(first.data), ...step.data.tool_calls.slice(1)] };
    });
    return rewritten.some((entry, index) => entry !== messages[index]) ? rewritten : undefined;
};

// The same for a chat-completions body. One that needs nothing, and one this can't read, come back byte-identical: an
// unparsable request is the upstream's to complain about, not ours.
export const withSignedToolCalls = (body: string): string => {
    const root = chatBodySchema.safeParse(parseJsonOr(body, undefined));
    const messages = root.success ? signedToolCalls(root.data.messages) : undefined;
    return !root.success || messages === undefined ? body : JSON.stringify({ ...root.data, messages });
};
