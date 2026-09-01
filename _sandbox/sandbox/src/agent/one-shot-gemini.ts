import type { Services } from "../composition.js";
import { OPENCODE_GEMINI_PROVIDER } from "../grok/opencode.js";

/* ONE PROMPT IN, ONE STRING OUT. ON GEMINI'S OWN RUNTIME. The same shape one-shot.ts serves, taking the other
 * road to the model, and it exists for one reason: THE CLAUDE CODE HARNESS CANNOT REACH GOOGLE.
 *
 * That CLI writes "You are a Claude agent, built on Anthropic's Claude Agent SDK." into the system block of
 * every request it makes, and Google's Antigravity channel refuses on that exact sentence, case-sensitively,
 * surviving any text added before or after it, and answering RESOURCE_EXHAUSTED as though a quota were spent.
 * It is not: the accounts refusing it were measured at ~0% of their weekly allowance. The sentence cannot be
 * removed through any supported option; setting our own system prompt ADDS to it rather than replacing it.
 *
 * So the helper stops speaking Claude Code to Google. The chat already made this move. Gemini turns run on the
 * OpenCode loop for exactly this reason (grok/opencode.ts says so where the provider is declared), and the
 * quick model was simply never taught the same thing: it knew one way to run a model, took it to a provider that
 * refuses it, and spent every landing rediscovering that. This is that fix, one layer down.
 *
 * The credential is the translator's, exactly as it is for a routed turn: OpenCode reaches Google through the
 * loopback translator as an OpenAI-compatible provider, and CLIProxyAPI holds the auth files and balances the
 * fleet behind it. Nothing here holds a credential, which is why nothing here resolves one.
 *
 * The settings mirror one-shot.ts's, for the same reasons stated there, no tools, no session left behind, its
 * own deadline. A helper is a one-liner nobody is watching. */

// The same ceiling the Claude Code helper runs under: past this, waiting cannot help and the chain has other
// rungs. Kept as its own constant rather than imported, because the two roads have no reason to move together.
const DEADLINE_MS = 20_000;

// Nothing to call. A commit subject is a rewrite of material already in the prompt, so a tool call here is a
// model wandering off rather than working, and OpenCode's wildcard is what says that without this file having
// to keep a list of tool names in step with the runtime's.
const NO_TOOLS = { "*": false } as const;

/* THE INSTRUCTION THAT REPLACES A CODING AGENT'S. OpenCode's own agent prompt is a coding loop's, which would
 * argue with a caller asking for one line, the same reason one-shot.ts wants an empty system prompt. Unlike
 * there, here it is honoured: this seam takes the prompt it is given.
 *
 * Deliberately says nothing about who the model is. The identity line is what Google refuses, and re-adding one
 * of our own would be re-earning the same refusal for no benefit, the caller's prompt already says what to
 * write. */
const SYSTEM = `Answer with exactly what the prompt asks for and nothing else. No preamble, no explanation, no code fences.`;

// The assistant's words out of OpenCode's parts. Anything that is not text (a tool call, a reasoning block) is
// not an answer to a one-liner, so it is dropped rather than stringified into the caller's commit subject.
const textOf = (parts: readonly { readonly type: string; readonly text?: string }[]): string =>
    parts
        .flatMap((part) => (part.type === `text` && typeof part.text === `string` ? [part.text] : []))
        .join(``)
        .trim();

/* THE SESSION IS NAMED ON CREATION, AND THAT IS NOT COSMETIC: it is what stops OpenCode spending a SECOND model
 * call on this one-liner.
 *
 * An unnamed session gets auto-titled. OpenCode fires its own "You are a title generator…" prompt at the same
 * provider as soon as the first message lands, carrying our whole prompt as the material to name, and then
 * writes the answer over a session we delete moments later. Measured against a recording upstream: two requests
 * per helper call unnamed, one when the session is created with a title. Every landing, every session title,
 * every held command paid double on the Gemini road.
 *
 * A title given here is a title OpenCode does not need to invent, so the pass simply never runs. Same trick
 * t3code uses on this API for the same reason (`title: "T3 Code ${operation}"`), and the string is never seen by
 * anybody: nothing reads this session, and the `finally` below deletes it. */
const HELPER_SESSION_TITLE = `intentic helper (one-shot)`;

export const runGeminiOneShot = async (params: {
    readonly services: Services;
    readonly prompt: string;
    // The tree OpenCode opens the session in. Nothing is read from it, there are no tools, but a session is
    // always scoped to a directory, and one that does not exist is refused.
    readonly cwd: string;
    readonly model: string;
    readonly signal: AbortSignal;
}): Promise<string> => {
    const client = await params.services.openCode.client();
    const created = await client.session.create({ query: { directory: params.cwd }, body: { title: HELPER_SESSION_TITLE } });
    const id = created.data?.id;
    if (id === undefined) {
        throw new Error(`the model did not answer (Gemini's runtime opened no session)`);
    }
    /* The deadline and the caller's cancel are the same act here, abort the session, and both have to also
     * end the WAIT, because aborting the session does not settle the request promise. */
    let expired = false;
    const abort = (): void => void client.session.abort({ path: { id } }).catch(() => {});
    const deadline = setTimeout(() => {
        expired = true;
        abort();
    }, DEADLINE_MS);
    params.signal.addEventListener(`abort`, abort, { once: true });
    try {
        const answered = await client.session.prompt({
            path: { id },
            query: { directory: params.cwd },
            body: {
                model: { providerID: OPENCODE_GEMINI_PROVIDER, modelID: params.model },
                system: SYSTEM,
                tools: { ...NO_TOOLS },
                parts: [{ type: `text`, text: params.prompt }],
            },
        });
        const text = textOf(answered.data?.parts ?? []);
        if (text === ``) {
            // Empty covers every way this rung can fail quietly, the deadline tore it down, the model called a
            // tool instead of answering, the provider returned an error part. The chain treats all of them the
            // same way, so the only thing worth distinguishing is the clock.
            throw new Error(expired ? `the model did not answer within ${DEADLINE_MS / 1_000}s` : `the model did not answer`);
        }
        return text;
    } catch (error) {
        throw expired ? new Error(`the model did not answer within ${DEADLINE_MS / 1_000}s`) : error;
    } finally {
        clearTimeout(deadline);
        params.signal.removeEventListener(`abort`, abort);
        /* NO SESSION LEFT BEHIND, the same promise one-shot.ts keeps with `persistSession: false`, kept here by
         * hand because OpenCode has no such option. Without it every landing would file a one-turn session in the
         * runtime's own store, which is the history-list pollution that file records paying for once already. */
        await client.session.delete({ path: { id } }).catch(() => {});
    }
};
