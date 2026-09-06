import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { sendableEffort, sendableThinking } from "@intentic/sandbox-contract";
import type { OneShotAsk } from "../../agent/providers/adapter.js";
import { isFailureSentence } from "../../agent/providers/failure-sentences.js";
import { type HarnessCredentials, harnessEnv, resolveHarnessCredentials } from "../../agent/providers/harness-credentials.js";
import type { Services } from "../../composition.js";
import { ONE_SHOT_OWNER, workloadStamp } from "../../platform/boot/leftovers.js";
import { sdk } from "./claude-sdk.js";

/* THE CLAUDE CODE HARNESS'S ONE-SHOT (agent/adapter.ts oneShot): no tools, no session, no transcript, no
 * events. The shape a helper needs as opposed to the shape a chat needs, and the two have almost nothing in
 * common: streamAgent exists to run an AGENT, hooks, tmux panes, MCP servers, plugin dirs, a resumable session, an
 * event stream several surfaces attach to, and every one of those is dead weight, latency and risk here. A
 * helper that loaded the workspace's CLAUDE.md and skills would also be a helper whose output changed when
 * someone edited a memory file, which is the opposite of what a mechanical one-liner should do.
 *
 * So the settings are deliberately the empty ones:
 *   settingSources: [] , no CLAUDE.md, no skills, no subagents, no project hooks. The SDK's own default,
 *                         restated here because streamAgent overrides it and this is the exception.
 *   persistSession: false, no transcript on disk. NOT a default; it has to be said, and this file said "no
 *                         session, no transcript" for a while before it was true. The SDK writes every query
 *                         to ~/.claude/projects/<cwd>/, and the cwd here is the WORKSPACE ROOT, the exact
 *                         project key the chat-history list reads (sessions.ts listWorkspaceSessions) and the
 *                         recall index scans. So every helper call filed a one-turn "session" whose title is
 *                         its own prompt, and the history menu filled up with "Name this coding-agent
 *                         session…" rows: 123 of 204 stored transcripts at the time this was found. Nothing
 *                         here is ever resumed, so the write bought nothing and cost the feature it polluted.
 *   allowedTools: []   , nothing to call. The model answers from the prompt or not at all.
 *   maxTurns: 1        , with no tools there is nothing to iterate on; this is the backstop that says so.
 *   no systemPrompt    , the SDK then sends an EMPTY one, which for a text task is right: the claude_code
 *                         preset is a coding agent's instructions and would only argue with the prompt.
 *   thinking: disabled , unless the pin says otherwise. See below.
 *
 * THINKING IS OFF UNLESS SOMEBODY ASKED FOR IT, and this is the one setting here that is not merely tidy.
 * Adaptive thinking is the SDK's DEFAULT on every model that supports it, cheap rungs included, so a helper that
 * says nothing gets it, and then spends thousands of reasoning tokens deciding a single line. Measured on Haiku
 * 4.5 against an ordinary commit diff: 27s and ~2.9k output tokens with the default, 2s and ~12 tokens with it
 * disabled, for the same subject line. That is the difference between an answer that lands while the user is
 * still looking and one that arrives long after. Most callers of this seam ask for a one-liner whose answer is a
 * rewrite of material already in the prompt, so there is nothing for a reasoning pass to add.
 *
 * WHICH IS AN ARGUMENT FOR THE DEFAULT AND NOT FOR A RULE, and it was a rule until the model lists became
 * per-role (contract model-roles.ts). An owner who pins a reasoning model to their commit subjects has said
 * something specific, and answering it by silently suppressing the thing they pinned FOR is worse than either
 * honouring it or refusing it: they pay the price of the model and get the behaviour of a cheaper one. So the
 * pin's own `thinking`/`effort` win where it states them, an unstated pin still gets the fast path above, and
 * the deadline stretches for a rung that was asked to think (see DEADLINE_MS).
 *
 * It runs on the same credentials the chat does (harness-credentials.ts), including the withholding rule that
 * keeps a subscription token away from a foreign endpoint, a helper is not a reason to authenticate a second
 * way. Errors propagate: every caller here decides for itself what a failure means, and swallowing a
 * credential problem into an empty string would make it look like the model had nothing to say. */

/* How long a helper will wait out a retry that is NOT a spent allowance, a connection blip, a 500, a momentary
 * overload, all of which the CLI clears in well under this. Long enough that an ordinary hiccup still produces
 * an answer, short enough that no caller here is ever left holding a process: every one of them is a one-liner
 * whose value is that it appeared while the user was still looking at the thing it names. */
const MAX_RETRY_WAIT_MS = 15_000;

/* THE WHOLE CALL'S DEADLINE, the ceiling the per-retry limit above cannot express.
 *
 * That limit refuses one long wait; it says nothing about MANY short ones, and short ones are what a struggling
 * provider actually produces. The harness's backoff climbs from ~600ms, so a rung can refuse a dozen times over
 * without any single delay coming near fifteen seconds, and the caller waits out every one of them, which is
 * how a draft advertised as "a few seconds" was measured at 35–73 seconds per landing, long after the user who
 * was promised it had given up and looked away.
 *
 * So the budget is stated once, for the call rather than the attempt. Deliberately generous against a model
 * that answers in ~2s: this is the point where waiting longer cannot help, not a latency target. Crossing it is
 * an ordinary refusal, askRoleModel steps to the next rung, which is the whole reason there is a chain.
 *
 * A RUNG ASKED TO THINK GETS THE LONGER ONE, because the twenty seconds above is measured against a model that
 * was told not to. Holding a reasoning pin to a non-reasoning deadline would time out every call, step the whole
 * chain, and read to the owner as "the model I chose is broken" rather than as "this seam refused to run it". */
const DEADLINE_MS = 20_000;
const THINKING_DEADLINE_MS = 90_000;

interface OneShotRun {
    readonly prompt: string;
    readonly cwd: string;
    readonly model: string;
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
    readonly credentials: HarnessCredentials;
    readonly signal: AbortSignal;
}

/* WHAT THE PIN ASKED FOR, read through the SAME two helpers a chat turn's options go through (agent.ts
 * reasoningOptions), so a rung and a turn cannot disagree about what an effort means beside a thinking switch:
 * `sendableEffort` clamps a tier that is off this model's scale, `sendableThinking` says whether reasoning is on
 * at all. An unpinned entry answers `undefined` to both, which is where the header's default comes back in:
 * thinking is written as disabled and no effort is sent. */
const reasoningOf = (run: OneShotRun): { readonly thinking: boolean | undefined; readonly effort: string | undefined } => ({
    thinking: sendableThinking(run.effort, run.thinking),
    effort: sendableEffort(run.effort, run.thinking),
});

// The SDK options for one call. Its own function because the run below is a stream loop with several exits, and
// a settings literal this long inside it is what pushed that loop past the point anybody reads it whole.
const oneShotOptions = (run: OneShotRun, abort: AbortController): Options => {
    const { endpoint, oauthToken } = run.credentials;
    const { thinking, effort } = reasoningOf(run);
    return {
        cwd: run.cwd,
        abortController: abort,
        settingSources: [],
        allowedTools: [],
        maxTurns: 1,
        // See the header: the workspace root is the history list's own project key, and a helper's prompt is
        // not a conversation the user had.
        persistSession: false,
        // The header's headline setting: the SDK thinks by default, and on a one-line rewrite that costs ~10x
        // the latency for the same answer. Written as `disabled` rather than left out, because leaving it out IS
        // the SDK's adaptive default; `adaptive` here is somebody having pinned it.
        thinking: { type: thinking === true ? `adaptive` : `disabled` },
        ...(effort === undefined ? {} : { effort: effort as NonNullable<Options["effort"]> }),
        // The speed request, where the pin made one. A request rather than a promise, exactly as it is on a turn.
        ...(run.fast === true ? { settings: { fastMode: true, fastModePerSessionOptIn: true } } : {}),
        // A routed provider is reached through a translator that maps model → upstream, so its endpoint names
        // the id; a native Claude call uses the pinned model directly.
        model: endpoint?.model ?? run.model,
        env: {
            ...process.env,
            ...harnessEnv({
                // A HELPER'S retry policy, not a turn's, see harness-credentials.ts. Nobody is watching this
                // one, and a rung that will not answer is meant to cost the chain a couple of seconds and be
                // stepped over, never to be waited out.
                helper: true,
                ...(endpoint !== undefined ? { baseUrl: endpoint.baseUrl, authToken: endpoint.authToken, model: endpoint.model } : {}),
                ...(oauthToken !== undefined ? { oauthToken } : {}),
            }),
            // A helper is seconds-scale by construction (see above: no tools, one turn, and a retry it will not
            // wait fifteen seconds for), so it carries the reserved owner nothing reports live, one still
            // running a grace window after this call gave up on it is a leftover, and the commonest one there is.
            ...workloadStamp(ONE_SHOT_OWNER),
        },
    };
};

// The harness run itself, on credentials already resolved: the seam the tests of the walk drive without a CLI.
const runOnHarness = async (run: OneShotRun): Promise<string> => {
    const abort = new AbortController();
    // The caller's signal is the user's cancel (a second click, a closed panel). Forwarded rather than passed
    // straight through because the session must also be torn down on the success path.
    const forward = (): void => abort.abort();
    run.signal.addEventListener(`abort`, forward, { once: true });
    /* The deadline tears the CLI down the same way a cancel does, then the loop below reads `expired` to say
     * which of the two happened, an abort surfaces as a stream that simply ends, and "the model did not
     * answer" would send the reader looking at the model rather than at the clock. */
    let expired = false;
    // Stretched for a rung somebody asked to think, see the constants: a reasoning pin held to the fast path's
    // deadline would time out every call and read as a broken model rather than as a refused setting.
    const budget = reasoningOf(run).thinking === true ? THINKING_DEADLINE_MS : DEADLINE_MS;
    const deadline = setTimeout(() => {
        expired = true;
        abort.abort();
    }, budget);
    const session = sdk().query({ prompt: run.prompt, options: oneShotOptions(run, abort) });
    try {
        for await (const message of session) {
            /* A RETRY THIS CALLER WILL NEVER OUTLIVE. A TURN should ride out a rate limit: the user asked for
             * it, is watching it, and would rather wait than lose the work, which is what the harness's own
             * watchdog buys it, and why this call is spawned WITHOUT that watchdog (harness-credentials.ts). A
             * helper is the opposite on every count, nobody is watching, nothing is lost by failing, and the
             * answer is worthless by the time it arrives.
             *
             * The watchdog being off shortens the harness's own budget; it does not put a floor under it, so
             * these two guards stay. They are the fast exits, a refusal recognised on the spot beats one the
             * deadline has to time out.
             *
             * Left unhandled, the loop below simply skips these frames and waits. Measured against a spent
             * allowance, the CLI answers 429 and schedules the next attempt for the window's remaining
             * lifetime, `retry_delay_ms: 21_600_000`, six hours, so `for await` never yields a result, the
             * caller's promise never settles, and the CLI process stays resident. One per call, until the
             * daemon restarts: 14 were alive when this was found, and not one title had ever been written.
             *
             * So the same distinction agent.ts draws for a live turn, drawn one notch tighter: a spent
             * allowance is terminal here rather than something to park on, and any other retry is ridden out
             * only while it stays within a helper's patience. The message is the provider's own sentence, which
             * failure-sentences.ts already teaches every caller to recognise and refuse as data. */
            if (message.type === `system` && message.subtype === `api_retry`) {
                if (message.error === `rate_limit`) {
                    // The vendor whose allowance this actually spent, not the harness running it, a helper on a
                    // routed turn is billed to Google or ChatGPT, and "Claude usage limit reached" would send the
                    // reader to an account in perfect health. The counts the chat's own frame carries are left
                    // out on purpose: nobody is watching a title pass, and a helper's job here is to fail fast.
                    const vendor = run.credentials.allowance?.vendor ?? `Claude`;
                    throw new Error(`${vendor} usage limit reached. Try again once it resets.`);
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
             * most damage. Every caller here asked for a one-liner it will use AS DATA, a commit subject, a
             * session title, so a reply that is really a failure poisons whatever field it lands in, silently
             * and often permanently (a title outranks the name it overwrote; see agents-registry promoteTitle).
             *
             * Two ways a failure wears a result's clothes, and the FLAG is the one that generalises: the CLI
             * files an API failure as a success-subtype result with `is_error` set and the provider's sentence
             * in `result`, which is how a title pass on a revoked token named four fleet cards "Failed to
             * authenticate. API Error: 401 …". The sentence check behind it is the backstop for the conditions
             * the CLI reports as prose without necessarily flagging (failure-sentences.ts), a spent allowance
             * arrives that way. Thrown with the sentence as the message, since it names the reset or the
             * credential the caller's UI can act on. */
            if (message.is_error || isFailureSentence(message.result)) {
                throw new Error(message.result.trim() === `` ? `the model did not answer` : message.result);
            }
            return message.result;
        }
        // The stream ended without a result: the deadline tore it down, the CLI died, or the turn was aborted
        // mid-flight. The first of those is the one worth naming, it is a statement about how long this rung
        // took, and every other sentence here would blame the model for it.
        throw new Error(expired ? `the model did not answer within ${DEADLINE_MS / 1_000}s` : `the model did not answer`);
    } catch (error) {
        // Tearing the CLI down mid-stream can surface as a throw rather than as a stream that ends, so the
        // deadline has to claim its own failures on both roads out, otherwise the chain records this rung as
        // having refused for whatever reason the abort happened to wear.
        throw expired ? new Error(`the model did not answer within ${DEADLINE_MS / 1_000}s`) : error;
    } finally {
        clearTimeout(deadline);
        run.signal.removeEventListener(`abort`, forward);
        abort.abort();
        await session.return(undefined).catch(() => {});
    }
};

// It runs on the same credentials the chat does (harness-credentials.ts), including the withholding rule that
// keeps a subscription token away from a foreign endpoint: a helper is not a reason to authenticate a second
// way. A credential that cannot be resolved is thrown in its own sentence, which names the reconnect.
export const claudeOneShot = async (services: Services, ask: OneShotAsk): Promise<string> => {
    const resolved = await resolveHarnessCredentials(services, { agent: ask.provider, model: ask.model });
    if (!resolved.ok) {
        throw new Error(resolved.message);
    }
    return runOnHarness({
        prompt: ask.prompt,
        cwd: ask.cwd,
        model: ask.model,
        // The pin's knobs, forwarded whole. Absent stays absent: a role whose entry configured nothing runs the
        // fast path the header describes, and nothing here fills one in.
        ...(ask.effort === undefined ? {} : { effort: ask.effort }),
        ...(ask.thinking === undefined ? {} : { thinking: ask.thinking }),
        ...(ask.fast === undefined ? {} : { fast: ask.fast }),
        credentials: resolved.credentials,
        signal: ask.signal,
    });
};
