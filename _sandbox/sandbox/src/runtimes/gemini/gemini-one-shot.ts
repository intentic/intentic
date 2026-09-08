import type { OneShotAsk } from "../../agent/providers/adapter.js";
import type { Services } from "../../composition.js";
import { OPENCODE_GEMINI_PROVIDER } from "../grok/opencode.js";

// Runs on OpenCode instead of the Claude Code harness: Google's Antigravity channel refuses any request whose system
// block carries the Claude Code CLI's identity line, as a false RESOURCE_EXHAUSTED. The translator holds the
// credential; OpenCode reaches Google through it as an OpenAI-compatible provider, so nothing here resolves one.

// Same ceiling as the Claude Code helper's; separate constant since the two roads move independently.
const DEADLINE_MS = 20_000;

// Nothing to call here; the wildcard avoids tracking OpenCode's own tool names in step.
const NO_TOOLS = { "*": false } as const;

// Replaces OpenCode's own coding-agent prompt, which would argue with a one-line request. Says nothing about who the
// model is, since an identity line is exactly what Google's channel refuses.
const SYSTEM = `Answer with exactly what the prompt asks for and nothing else. No preamble, no explanation, no code fences.`;

// Non-text parts (a tool call, a reasoning block) are dropped rather than stringified into the answer.
const textOf = (parts: readonly { readonly type: string; readonly text?: string }[]): string =>
    parts
        .flatMap((part) => (part.type === `text` && typeof part.text === `string` ? [part.text] : []))
        .join(``)
        .trim();

// Given up front so OpenCode's auto-title pass (a second model call) never fires; the string is never read.
const HELPER_SESSION_TITLE = `intentic helper (one-shot)`;

export const geminiOneShot = async (services: Pick<Services, "openCode">, ask: OneShotAsk): Promise<string> => {
    const client = await services.openCode.client();
    const created = await client.session.create({ query: { directory: ask.cwd }, body: { title: HELPER_SESSION_TITLE } });
    const id = created.data?.id;
    if (id === undefined) {
        throw new Error(`the model did not answer (Gemini's runtime opened no session)`);
    }
    // Deadline and cancel both abort the session, and must also end the wait; abort alone won't settle it.
    let expired = false;
    const abort = (): void => void client.session.abort({ path: { id } }).catch(() => {});
    const deadline = setTimeout(() => {
        expired = true;
        abort();
    }, DEADLINE_MS);
    ask.signal.addEventListener(`abort`, abort, { once: true });
    try {
        const answered = await client.session.prompt({
            path: { id },
            query: { directory: ask.cwd },
            // No effort knob: OpenCode names only (provider, model), and Google's catalog rows publish no effort scale.
            body: {
                model: { providerID: OPENCODE_GEMINI_PROVIDER, modelID: ask.model },
                system: SYSTEM,
                tools: { ...NO_TOOLS },
                parts: [{ type: `text`, text: ask.prompt }],
            },
        });
        const text = textOf(answered.data?.parts ?? []);
        if (text === ``) {
            // Empty covers every quiet failure alike; only the clock is worth distinguishing.
            throw new Error(expired ? `the model did not answer within ${DEADLINE_MS / 1_000}s` : `the model did not answer`);
        }
        return text;
    } catch (error) {
        throw expired ? new Error(`the model did not answer within ${DEADLINE_MS / 1_000}s`) : error;
    } finally {
        clearTimeout(deadline);
        ask.signal.removeEventListener(`abort`, abort);
        // Same guarantee as persistSession: false on the Claude Code helper, done by hand; OpenCode has no such option.
        await client.session.delete({ path: { id } }).catch(() => {});
    }
};
