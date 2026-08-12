import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { ONE_SHOT_OWNER, workloadStamp } from "../platform/leftovers.js";
import { type HarnessCredentials, harnessEnv } from "./harness-credentials.js";
import { isFailureSentence } from "./failure-sentences.js";

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
 *   persistSession: false — no transcript on disk. NOT a default; it has to be said, and this file said "no
 *                         session, no transcript" for a while before it was true. The SDK writes every query
 *                         to ~/.claude/projects/<cwd>/, and the cwd here is the WORKSPACE ROOT — the exact
 *                         project key the chat-history list reads (sessions.ts listWorkspaceSessions) and the
 *                         recall index scans. So every helper call filed a one-turn "session" whose title is
 *                         its own prompt, and the history menu filled up with "Name this coding-agent
 *                         session…" rows: 123 of 204 stored transcripts at the time this was found. Nothing
 *                         here is ever resumed, so the write bought nothing and cost the feature it polluted.
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
 * the same subject line. That is the difference between an answer that lands while the user is still looking
 * and one that arrives long after. Every caller of this seam is a one-liner (a commit subject, a session title) where the
 * answer is a rewrite of material already in the prompt, so there is nothing for a reasoning pass to add.
 *
 * It runs on the same credentials the chat does (harness-credentials.ts), including the withholding rule that
 * keeps a subscription token away from a foreign endpoint — a helper is not a reason to authenticate a second
 * way. Errors propagate: every caller here decides for itself what a failure means, and swallowing a
 * credential problem into an empty string would make it look like the model had nothing to say. */

/* How long a helper will wait out a retry that is NOT a spent allowance — a connection blip, a 500, a momentary
 * overload, all of which the CLI clears in well under this. Long enough that an ordinary hiccup still produces
 * an answer, short enough that no caller here is ever left holding a process: every one of them is a one-liner
 * whose value is that it appeared while the user was still looking at the thing it names. */
const MAX_RETRY_WAIT_MS = 15_000;

/* THE WHOLE CALL'S DEADLINE — the ceiling the per-retry limit above cannot express.
 *
 * That limit refuses one long wait; it says nothing about MANY short ones, and short ones are what a struggling
 * provider actually produces. The harness's backoff climbs from ~600ms, so a rung can refuse a dozen times over
 * without any single delay coming near fifteen seconds, and the caller waits out every one of them — which is
 * how a draft advertised as "a few seconds" was measured at 35–73 seconds per landing, long after the user who
 * was promised it had given up and looked away.
 *
 * So the budget is stated once, for the call rather than the attempt. Deliberately generous against a model
 * that answers in ~2s: this is the point where waiting longer cannot help, not a latency target. Crossing it is
 * an ordinary refusal — askQuickModel steps to the next rung, which is the whole reason there is a chain. */
const DEADLINE_MS = 20_000;

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
    /* The deadline tears the CLI down the same way a cancel does, then the loop below reads `expired` to say
     * which of the two happened — an abort surfaces as a stream that simply ends, and "the model did not
     * answer" would send the reader looking at the model rather than at the clock. */
    let expired = false;
    const deadline = setTimeout(() => {
        expired = true;
        abort.abort();
    }, DEADLINE_MS);
    const { endpoint, oauthToken } = params.credentials;
    const options: Options = {
        cwd: params.cwd,
        abortController: abort,
        settingSources: [],
        allowedTools: [],
        maxTurns: 1,
        // See the header: the workspace root is the history list's own project key, and a helper's prompt is
        // not a conversation the user had.
        persistSession: false,
        // The header's headline setting: the SDK thinks by default, and on a one-line rewrite that costs ~10x
        // the latency for the same answer.
        thinking: { type: `disabled` },
        // A routed provider is reached through a translator that maps model → upstream, so its endpoint names
        // the id; a native Claude call uses the resolved quick model directly.
        model: endpoint?.model ?? params.model,
        env: {
            ...process.env,
            ...harnessEnv({
                // A HELPER'S retry policy, not a turn's — see harness-credentials.ts. Nobody is watching this
                // one, and a rung that will not answer is meant to cost the chain a couple of seconds and be
                // stepped over, never to be waited out.
                helper: true,
                ...(endpoint !== undefined ? { baseUrl: endpoint.baseUrl, authToken: endpoint.authToken, model: endpoint.model } : {}),
                ...(oauthToken !== undefined ? { oauthToken } : {}),
            }),
            // A helper is seconds-scale by construction (see above: no tools, one turn, and a retry it will not
            // wait fifteen seconds for), so it carries the reserved owner nothing reports live — one still
            // running a grace window after this call gave up on it is a leftover, and the commonest one there is.
            ...workloadStamp(ONE_SHOT_OWNER),
        },
    };
    const session = query({ prompt: params.prompt, options });
    try {
        for await (const message of session) {
            /* A RETRY THIS CALLER WILL NEVER OUTLIVE. A TURN should ride out a rate limit: the user asked for
             * it, is watching it, and would rather wait than lose the work — which is what the harness's own
             * watchdog buys it, and why this call is spawned WITHOUT that watchdog (harness-credentials.ts). A
             * helper is the opposite on every count — nobody is watching, nothing is lost by failing, and the
             * answer is worthless by the time it arrives.
             *
             * The watchdog being off shortens the harness's own budget; it does not put a floor under it, so
             * these two guards stay. They are the fast exits — a refusal recognised on the spot beats one the
             * deadline has to time out.
             *
             * Left unhandled, the loop below simply skips these frames and waits. Measured against a spent
             * allowance, the CLI answers 429 and schedules the next attempt for the window's remaining
             * lifetime — `retry_delay_ms: 21_600_000`, six hours — so `for await` never yields a result, the
             * caller's promise never settles, and the CLI process stays resident. One per call, until the
             * daemon restarts: 14 were alive when this was found, and not one title had ever been written.
             *
             * So the same distinction agent.ts draws for a live turn, drawn one notch tighter: a spent
             * allowance is terminal here rather than something to park on, and any other retry is ridden out
             * only while it stays within a helper's patience. The message is the provider's own sentence, which
             * failure-sentences.ts already teaches every caller to recognise and refuse as data. */
            if (message.type === `system` && message.subtype === `api_retry`) {
                if (message.error === `rate_limit`) {
                    // The vendor whose allowance this actually spent, not the harness running it — a helper on a
                    // routed turn is billed to Google or ChatGPT, and "Claude usage limit reached" would send the
                    // reader to an account in perfect health. The counts the chat's own frame carries are left
                    // out on purpose: nobody is watching a title pass, and a helper's job here is to fail fast.
                    const vendor = params.credentials.allowance?.vendor ?? `Claude`;
                    throw new Error(`${vendor} usage limit reached — the allowance is exhausted. Try again once it resets.`);
                }
                if (message.retry_delay_ms > MAX_RETRY_WAIT_MS) {
                    throw new Error(`the model did not answer (retry deferred ${Math.round(message.retry_delay_ms / 1000)}s)`);
                }
            }
            if (message.type !== `result`) {
                continue;
            }
            if (message.subtype !== `success`) {
                throw new Error(`the model did not answer (${message.subtype})`);
            }
            /* A `success` SUBTYPE IS NOT A SUCCESS, and this is the seam where believing otherwise does the
             * most damage. Every caller here asked for a one-liner it will use AS DATA — a commit subject, a
             * session title — so a reply that is really a failure poisons whatever field it lands in, silently
             * and often permanently (a title outranks the name it overwrote; see agents-registry promoteTitle).
             *
             * Two ways a failure wears a result's clothes, and the FLAG is the one that generalises: the CLI
             * files an API failure as a success-subtype result with `is_error` set and the provider's sentence
             * in `result`, which is how a title pass on a revoked token named four fleet cards "Failed to
             * authenticate. API Error: 401 …". The sentence check behind it is the backstop for the conditions
             * the CLI reports as prose without necessarily flagging (failure-sentences.ts) — a spent allowance
             * arrives that way. Thrown with the sentence as the message, since it names the reset or the
             * credential the caller's UI can act on. */
            if (message.is_error || isFailureSentence(message.result)) {
                throw new Error(message.result.trim() === `` ? `the model did not answer` : message.result);
            }
            return message.result;
        }
        // The stream ended without a result: the deadline tore it down, the CLI died, or the turn was aborted
        // mid-flight. The first of those is the one worth naming — it is a statement about how long this rung
        // took, and every other sentence here would blame the model for it.
        throw new Error(expired ? `the model did not answer within ${DEADLINE_MS / 1_000}s` : `the model did not answer`);
    } catch (error) {
        // Tearing the CLI down mid-stream can surface as a throw rather than as a stream that ends, so the
        // deadline has to claim its own failures on both roads out — otherwise the chain records this rung as
        // having refused for whatever reason the abort happened to wear.
        throw expired ? new Error(`the model did not answer within ${DEADLINE_MS / 1_000}s`) : error;
    } finally {
        clearTimeout(deadline);
        params.signal.removeEventListener(`abort`, forward);
        abort.abort();
        await session.return(undefined).catch(() => {});
    }
};
