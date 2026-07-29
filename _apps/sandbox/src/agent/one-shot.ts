import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { type HarnessCredentials, harnessEnv } from "./harness-credentials.js";
import { isUsageLimitText } from "./usage-limit-text.js";

/* ONE PROMPT IN, ONE STRING OUT — no tools, no session, no transcript, no events. The shape a helper needs
 * (draft me a commit message) as opposed to the shape a chat needs, and the two have almost nothing in common:
 * streamAgent exists to run an AGENT — hooks, tmux panes, MCP servers, plugin dirs, a resumable session, an
 * event stream several surfaces attach to — and every one of those is dead weight, latency and risk here. A
 * helper that loaded the workspace's CLAUDE.md and skills would also be a helper whose output changed when
 * someone edited a memory file, which is the opposite of what a mechanical one-liner should do.
 *
 * So the settings are deliberately the empty ones:
 *   settingSources: []  — no CLAUDE.md, no skills, no subagents, no project hooks. The SDK's own default,
 *                         restated here because streamAgent overrides it and this is the exception.
 *   allowedTools: []    — nothing to call. The model answers from the prompt or not at all.
 *   maxTurns: 1         — with no tools there is nothing to iterate on; this is the backstop that says so.
 *   no systemPrompt     — the SDK then sends an EMPTY one, which for a text task is right: the claude_code
 *                         preset is a coding agent's instructions and would only argue with the prompt.
 *   thinking: disabled  — see below. NOT a default; it has to be said.
 *
 * THINKING IS OFF, EXPLICITLY, and this is the one setting here that is not merely tidy. Adaptive thinking is
 * the SDK's DEFAULT on every model that supports it, quick rungs included, so a helper that says nothing gets
 * it — and then spends thousands of reasoning tokens deciding a single line. Measured on Haiku 4.5 against an
 * ordinary commit diff: 27s and ~2.9k output tokens with the default, 2s and ~12 tokens with it disabled, for
 * the same subject line. That is the difference between a sparkle click that feels instant and one the user
 * assumes is broken. Every caller of this seam is a one-liner (a commit subject, a session title) where the
 * answer is a rewrite of material already in the prompt, so there is nothing for a reasoning pass to add.
 *
 * It runs on the same credentials the chat does (harness-credentials.ts), including the withholding rule that
 * keeps a subscription token away from a foreign endpoint — a helper is not a reason to authenticate a second
 * way. Errors propagate: every caller here is a click that can report its own failure, and swallowing a
 * credential problem into an empty string would make it look like the model had nothing to say. */

export const runOneShot = async (params: {
    readonly prompt: string;
    // The tree the model runs in. Nothing is read from it (no tools), but the SDK spawns the CLI there and a
    // path that doesn't exist fails the spawn.
    readonly cwd: string;
    readonly model: string;
    readonly credentials: HarnessCredentials;
    readonly signal: AbortSignal;
}): Promise<string> => {
    const abort = new AbortController();
    // The caller's signal is the user's cancel (a second click, a closed panel). Forwarded rather than passed
    // straight through because the session must also be torn down on the success path.
    const forward = (): void => abort.abort();
    params.signal.addEventListener(`abort`, forward, { once: true });
    const { endpoint, oauthToken } = params.credentials;
    const options: Options = {
        cwd: params.cwd,
        abortController: abort,
        settingSources: [],
        allowedTools: [],
        maxTurns: 1,
        // The header's headline setting: the SDK thinks by default, and on a one-line rewrite that costs ~10x
        // the latency for the same answer.
        thinking: { type: `disabled` },
        // A routed provider is reached through a translator that maps model → upstream, so its endpoint names
        // the id; a native Claude call uses the resolved quick model directly.
        model: endpoint?.model ?? params.model,
        env: {
            ...process.env,
            ...harnessEnv({
                ...(endpoint !== undefined ? { baseUrl: endpoint.baseUrl, authToken: endpoint.authToken, model: endpoint.model } : {}),
                ...(oauthToken !== undefined ? { oauthToken } : {}),
            }),
        },
    };
    const session = query({ prompt: params.prompt, options });
    try {
        for await (const message of session) {
            if (message.type !== `result`) {
                continue;
            }
            if (message.subtype !== `success`) {
                throw new Error(`the model did not answer (${message.subtype})`);
            }
            // A spent allowance comes back as a SUCCESSFUL result whose text is the refusal sentence
            // ("You've hit your session limit · resets …"). Every caller here asked for a one-liner it will
            // use AS DATA — a commit subject, a session title — so returning the sentence poisons whatever
            // field it lands in. It is a failure wearing a result's clothes; throw it as the failure it is,
            // with the sentence as the message since it names the reset the caller's UI can show.
            if (isUsageLimitText(message.result)) {
                throw new Error(message.result);
            }
            return message.result;
        }
        // The stream ended without a result: the CLI died, or the turn was aborted mid-flight.
        throw new Error(`the model did not answer`);
    } finally {
        params.signal.removeEventListener(`abort`, forward);
        abort.abort();
        await session.return(undefined).catch(() => {});
    }
};
