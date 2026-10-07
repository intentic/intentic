import { randomUUID } from "node:crypto";
import { type AgentEvent, type AgentHarness, type AgentProvider, type RoutedAgentTurn, sendableThinking } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { ArmPlan, TurnArmPlan, TurnContext } from "../../providers/adapter.js";
import { readableProviderText } from "../../providers/provider-error-text.js";
import { classifyFailure, type ErrorFrame, type FailureQueries } from "../frames/classify-failure.js";
import { recordQueries } from "../frames/failure-queries.js";
import { fileFailureWrites, providerAnswered } from "../frames/frame-effects.js";
import { type SealedDeadline, sealedDeadline } from "./sealed-deadline.js";

// A helper job (a title, a commit subject, a verdict, a route) as a request on the turn's own seam: planned by the
// runtime's arm (adapter.preflight), run by its loop (plan.run), its failures classified and filed by the turn's own
// classifier, into the same records the next turn's account choice reads. What sets it apart is the profile it carries,
// `policy.sealed` (agent-request.ts): the prompt is everything the model reads, so the privacy shield reads the request
// whole instead of refusing its runtime (privacy-shield.ts `seal`), and no conversation, transcript or board row is
// made for it. One prompt in, one string out, under a deadline of its own.

// What a helper is told besides its prompt, under every runtime. Nothing about who the model is: an identity line is
// exactly what Google's channel refuses (runtimes/gemini/gemini-provider.ts).
export const SEALED_SYSTEM_PROMPT = "Answer with exactly what the prompt asks for and nothing else. No preamble, no explanation, no code fences.";

// The whole call's ceiling, longer for a model asked to think; the sentence always names the fast-path figure.
const DEADLINE_MS = 20_000;
const THINKING_DEADLINE_MS = 90_000;

// How long a provider's own retry may be waited out: long enough to survive a blip, short enough not to hold a caller.
const MAX_RETRY_WAIT_MS = 15_000;

export interface SealedAsk {
    // Whose credential and catalog it runs on, and the loop the pin names; the adapter table picks the runtime.
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    readonly model: string;
    // How the pin says to run it; absent means no thinking, no effort, no speed request.
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
    readonly prompt: string;
    // The conversation the job is for, where it has one (a land's commit subject, a chat's title): a grant the owner
    // made there counts for it, on the wire and in the shield's own reading alike.
    readonly conversationId?: string | undefined;
    // The caller's cancel: a second click, a closed panel.
    readonly signal: AbortSignal;
}

// A sealed request belongs to no conversation, so classification never asks it a conversation's questions: nothing is
// held for a resume, there is no ladder to climb.
const sealedQueries = (services: Services): FailureQueries => ({
    ...recordQueries(services),
    breakPolicy: () => Promise.reject(new Error("a sealed request has no conversation to hold")),
    stopLadder: () => {
        throw new Error("a sealed request has no conversation to resume");
    },
});

// The request every arm builds on, with nothing but the words, where they run, and the knobs the pin named.
const sealedContext = (services: Services, ask: SealedAsk, prompt: string, signal: AbortSignal): TurnContext => {
    const root = services.workspace.root;
    return {
        base: {
            spec: {
                prompt,
                cwd: root,
                model: ask.model,
                ...opt("effort", ask.effort),
                ...opt("fast", ask.fast),
                systemPromptMode: "custom",
                systemPrompt: SEALED_SYSTEM_PROMPT,
            },
            policy: { sealed: true },
            tools: {},
            // No card is ever raised by a request that can call nothing; the seam is required, not used.
            hooks: { cards: services.cards },
            signal,
        },
        attachmentPaths: [],
        localCwd: root,
        effectiveCwd: root,
        cliEnv: {},
        steering: undefined,
    };
};

// One run of a planned request, as far as it got.
interface SealedRun {
    readonly ask: SealedAsk;
    readonly plan: ArmPlan;
    readonly sessionId: string | undefined;
    readonly answered: boolean;
}

// How one planned run ended: the answer, or the provider's refusal, filed by then, and whether it was a spent allowance
// (a fact about the account that served it, which another account may not share).
type RunOutcome = { readonly answer: string } | { readonly refusal: Error; readonly spent: boolean };

// A failure frame as the turn reads it, classified and filed (a spent allowance against its account and model, a refused
// credential against its provider) before the next plan reads those records back, and said in the provider's own words.
const failure = async (services: Services, event: ErrorFrame, ran: SealedRun): Promise<RunOutcome> => {
    const { ask, plan } = ran;
    // No conversation here even when the job is for one: what a conversation's failure holds is that conversation's.
    const turn = { prompt: plan.request.spec.prompt, agent: ask.provider, harness: ask.harness, model: ask.model };
    try {
        const classified = await classifyFailure(
            event,
            {
                turn,
                turnId: randomUUID(),
                provider: ask.provider,
                model: plan.request.spec.model,
                account: plan.account,
                attribution: opt("account", plan.account),
                sessionId: ran.sessionId,
                answered: ran.answered,
                remint: undefined,
                limitReset: undefined,
                outage: undefined,
                standing: { state: "no-code", paths: [], check: undefined },
                checklist: undefined,
                contextTokens: undefined,
                now: Date.now(),
            },
            sealedQueries(services),
        );
        await fileFailureWrites(services, classified.writes);
    } catch (error) {
        services.logger.warn({ err: error, provider: ask.provider }, "sealed request: the failure could not be filed");
    }
    return { refusal: new Error(readableProviderText(event.message)), spent: event.code === "rate_limit" };
};

// Runs the planned request to its last frame and answers with its prose. A retry the provider defers past what a helper
// can wait is the end of it; so is an error frame, once filed.
const runOnce = async (services: Services, ask: SealedAsk, plan: ArmPlan, deadline: SealedDeadline): Promise<RunOutcome> => {
    let text = "";
    let sessionId: string | undefined;
    let answered = false;
    const frames: AsyncIterable<AgentEvent> = plan.run(plan.request.spec);
    for await (const event of frames) {
        if (event.kind === "session") {
            sessionId = event.sessionId;
        } else if (event.kind === "delta" && event.parentToolUseId === undefined) {
            // The first words on the wire settle what this provider and account last refused, as a turn's do.
            if (!answered) {
                answered = true;
                providerAnswered(services, ask.provider, plan.account);
            }
            text += event.text;
        } else if (event.kind === "provider_retry" && (event.nextAttemptAt ?? 0) - Date.now() > MAX_RETRY_WAIT_MS) {
            throw new Error(`the model did not answer (retry deferred ${Math.round(((event.nextAttemptAt ?? 0) - Date.now()) / 1000)}s)`);
        } else if (event.kind === "error") {
            return failure(services, event, { ask, plan, sessionId, answered });
        }
    }
    const answer = text.trim();
    if (answer === "") {
        // Empty covers every quiet ending alike; only the clock is worth naming.
        throw deadline.unanswered();
    }
    return { answer };
};

// Plans and runs the request, and plans it once more after a spent allowance: the refusal filed against one account is
// what sends the arm's account choice to a sibling with room, the move a turn's limit makes through its conversation's
// booking (models/limit-way.ts), which a sealed request has none of. Past that, or back on an account already refused,
// there is nothing left to try here, and a helper's chain has other models.
const answerOf = async (services: Services, ask: SealedAsk, plan: () => Promise<TurnArmPlan>, deadline: SealedDeadline): Promise<string> => {
    const refused = new Set<string>();
    let last: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the second plan reads what the first run's refusal filed
        const planned = await plan();
        if (!planned.ok) {
            throw last ?? new Error(planned.message);
        }
        if (planned.account !== undefined && refused.has(planned.account)) {
            break;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one run at a time, on the account the plan just chose
        const outcome = await runOnce(services, ask, planned, deadline);
        if ("answer" in outcome) {
            return outcome.answer;
        }
        if (!outcome.spent || planned.account === undefined) {
            throw outcome.refusal;
        }
        refused.add(planned.account);
        last = outcome.refusal;
    }
    throw last ?? deadline.unanswered();
};

export const runSealedRequest = async (services: Services, ask: SealedAsk): Promise<string> => {
    const adapter = services.adapters.for(ask.provider, ask.harness);
    if (adapter.sealed !== true) {
        throw new Error(`${adapter.runtime} runs no helper, so there is nothing to ask it one line with.`);
    }
    // Read whole before any runtime has it, and masked where the provider is untrusted on a wire the gateway can't cover.
    const sealed = await services.privacyShield.seal({
        provider: ask.provider,
        harness: ask.harness,
        conversationId: ask.conversationId,
        prompt: ask.prompt,
    });
    // The caller's cancel is forwarded rather than passed through, since an answer must tear the loop down too. Covers
    // every attempt: a rung the chain is waiting on must not double its budget by being planned again.
    const abort = new AbortController();
    const budget = sendableThinking(ask.effort, ask.thinking) === true ? THINKING_DEADLINE_MS : DEADLINE_MS;
    const deadline = sealedDeadline(ask.signal, budget, () => abort.abort(), DEADLINE_MS);
    const input: RoutedAgentTurn = {
        prompt: sealed.prompt,
        agent: ask.provider,
        harness: ask.harness,
        model: ask.model,
        ...opt("effort", ask.effort),
        ...opt("thinking", ask.thinking),
        ...opt("fast", ask.fast),
        // What the gateway reads a conversation's grant by, for a runtime behind it.
        ...opt("conversationId", ask.conversationId),
    };
    try {
        const plan = (): Promise<TurnArmPlan> => adapter.preflight(services, input, sealedContext(services, ask, sealed.prompt, abort.signal), []);
        return sealed.restore(await answerOf(services, ask, plan, deadline));
    } catch (error) {
        // A failure once the clock ran out is the clock's, whatever the torn-down loop threw instead.
        throw ask.signal.aborted && !deadline.expired() ? error : deadline.claim(error);
    } finally {
        deadline.release();
        abort.abort();
    }
};
