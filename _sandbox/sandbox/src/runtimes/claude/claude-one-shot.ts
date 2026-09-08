import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { sendableEffort, sendableThinking } from "@intentic/sandbox-contract";
import type { OneShotAsk } from "../../agent/providers/adapter.js";
import { isFailureSentence } from "../../agent/providers/failure-sentences.js";
import { type HarnessCredentials, harnessEnv, resolveHarnessCredentials } from "../../agent/providers/harness-credentials.js";
import type { Services } from "../../composition.js";
import { ONE_SHOT_OWNER, workloadStamp } from "../../platform/boot/leftovers.js";
import { sdk } from "./claude-sdk.js";

// Claude's one-shot helper (agent/adapter.ts oneShot): no tools, session, transcript or events, so its output doesn't
// drift with workspace state. Settings match SDK defaults except persistSession:false and thinking disabled unless
// pinned. Errors propagate rather than becoming an empty string.

// How long to wait out an ordinary retry; short enough not to hold a caller, long enough to survive a blip.
const MAX_RETRY_WAIT_MS = 15_000;

// Ceiling for the whole call: short retries can outlast MAX_RETRY_WAIT_MS unnoticed; longer if thinking.
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

// Reads the pin through the same helpers a chat turn uses (agent.ts reasoningOptions), so the two can't disagree about
// effort/thinking. Unpinned answers undefined to both, falling to disabled thinking and no effort.
const reasoningOf = (run: OneShotRun): { readonly thinking: boolean | undefined; readonly effort: string | undefined } => ({
    thinking: sendableThinking(run.effort, run.thinking),
    effort: sendableEffort(run.effort, run.thinking),
});

// SDK options for one call, split out so the stream loop below (several exits) doesn't drown in a long settings
// literal.
const oneShotOptions = (run: OneShotRun, abort: AbortController): Options => {
    const { endpoint, oauthToken } = run.credentials;
    const { thinking, effort } = reasoningOf(run);
    return {
        cwd: run.cwd,
        abortController: abort,
        settingSources: [],
        allowedTools: [],
        maxTurns: 1,
        // The workspace root is the history list's own project key; a helper's prompt is not a saved conversation.
        persistSession: false,
        // Written as disabled rather than omitted, since omitting it is the SDK's own adaptive-thinking default.
        thinking: { type: thinking === true ? `adaptive` : `disabled` },
        ...(effort === undefined ? {} : { effort: effort as NonNullable<Options["effort"]> }),
        // The speed request where the pin made one; a request, not a promise, same as on a turn.
        ...(run.fast === true ? { settings: { fastMode: true, fastModePerSessionOptIn: true } } : {}),
        // A routed provider's endpoint already names the upstream model id; a native Claude call uses the pinned model.
        model: endpoint?.model ?? run.model,
        env: {
            ...process.env,
            ...harnessEnv({
                // A helper's retry policy: a rung that won't answer costs seconds and gets stepped over, not waited
                // out.
                helper: true,
                ...(endpoint !== undefined ? { baseUrl: endpoint.baseUrl, authToken: endpoint.authToken, model: endpoint.model } : {}),
                ...(oauthToken !== undefined ? { oauthToken } : {}),
            }),
            // Tags the process with an owner: one still running after this call gave up is a leftover, and a common
            // one.
            ...workloadStamp(ONE_SHOT_OWNER),
        },
    };
};

// The harness run itself, on already-resolved credentials; the seam tests drive without a real CLI.
const runOnHarness = async (run: OneShotRun): Promise<string> => {
    const abort = new AbortController();
    // Caller's signal is the user's cancel, forwarded rather than passed through since success must tear down too.
    const forward = (): void => abort.abort();
    run.signal.addEventListener(`abort`, forward, { once: true });
    // Deadline and cancel both end the stream the same way; expired says which one actually happened.
    let expired = false;
    // Longer for a rung asked to think; the fast-path deadline would time out every reasoning call otherwise.
    const budget = reasoningOf(run).thinking === true ? THINKING_DEADLINE_MS : DEADLINE_MS;
    const deadline = setTimeout(() => {
        expired = true;
        abort.abort();
    }, budget);
    const session = sdk().query({ prompt: run.prompt, options: oneShotOptions(run, abort) });
    try {
        for await (const message of session) {
            // A live turn rides out a rate limit via a watchdog; this call has none, so a spent allowance is terminal
            // here.
            if (message.type === `system` && message.subtype === `api_retry`) {
                if (message.error === `rate_limit`) {
                    // Names the vendor actually billed (a routed helper may bill Google/ChatGPT), not the harness
                    // running it.
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
            // A success subtype can still be a failure (is_error, or an unflagged sentence); callers treat it as data.
            if (message.is_error || isFailureSentence(message.result)) {
                throw new Error(message.result.trim() === `` ? `the model did not answer` : message.result);
            }
            return message.result;
        }
        // Stream ended with no result (deadline, CLI death, or abort); only the deadline is worth naming.
        throw new Error(expired ? `the model did not answer within ${DEADLINE_MS / 1_000}s` : `the model did not answer`);
    } catch (error) {
        // A torn-down CLI can throw instead of ending the stream, so the deadline must claim its failure on both exits.
        throw expired ? new Error(`the model did not answer within ${DEADLINE_MS / 1_000}s`) : error;
    } finally {
        clearTimeout(deadline);
        run.signal.removeEventListener(`abort`, forward);
        abort.abort();
        await session.return(undefined).catch(() => {});
    }
};

// Runs on the same credentials as chat, including the rule that keeps a subscription token off a foreign endpoint. An
// unresolved credential throws its own sentence, naming the reconnect.
export const claudeOneShot = async (services: Services, ask: OneShotAsk): Promise<string> => {
    const resolved = await resolveHarnessCredentials(services, { agent: ask.provider, model: ask.model });
    if (!resolved.ok) {
        throw new Error(resolved.message);
    }
    return runOnHarness({
        prompt: ask.prompt,
        cwd: ask.cwd,
        model: ask.model,
        // Pin knobs forwarded whole; absent stays absent, so an unconfigured role runs the fast path.
        ...(ask.effort === undefined ? {} : { effort: ask.effort }),
        ...(ask.thinking === undefined ? {} : { thinking: ask.thinking }),
        ...(ask.fast === undefined ? {} : { fast: ask.fast }),
        credentials: resolved.credentials,
        signal: ask.signal,
    });
};
