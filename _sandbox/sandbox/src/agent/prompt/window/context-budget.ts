import { type AgentCapabilities, type AgentProvider, endpointIdOf, isTrialProvider } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { endpointConfigOf } from "../../../endpoints/local-model.js";
import { routedModel } from "../../providers/harness-credentials.js";

// Whether a model's context window can hold a turn at all, checked before anything is sent; trimming the prompt cannot
// fix a window that is fundamentally too small. Deliberately approximate and biased toward letting a turn through: an
// unknown window (no `contextWindow`) is never gated.

// Harness's own fixed cost per runtime, in tokens (an estimate); absent means unmeasured, and gates nothing.
const HARNESS_FLOOR_TOKENS: Partial<Record<AgentCapabilities["runtime"], number>> = { "claude-code": 20_000 };

// Room reserved for the reply; a truncated answer just spends the whole window again on retry.
const OUTPUT_RESERVE_TOKENS = 2_000;

// Rough chars-per-token rate every budget in this daemon counts at (workspace-map.ts, runtime-history.ts).
const CHARS_PER_TOKEN = 4;

// A one-shot helper's reply: a commit subject, a session title, a verdict and at most a short document. Far below a
// turn's reserve because nothing here writes code.
const HELPER_REPLY_TOKENS = 1_000;

const withCommas = (value: number): string =>
    Math.round(value)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");

// How many characters of prompt a one-shot helper may spend on a model that declared a window (role-model.ts).
//
// The arithmetic is not the turn's below, and deliberately: a helper carries no tools, no session and no transcript
// (claude-one-shot.ts sends `allowedTools: []`, `settingSources: []`, `maxTurns: 1`), so the harness floor that makes
// turns fail simply is not there. The whole window minus room to answer is genuinely the helper's to spend.
//
// Infinity where the window is unknown, so a caller can size against it arithmetically without branching, and so an
// unknown window never makes a helper send less than it would have.
export const helperPromptRoom = (declared: DeclaredWindow | undefined): number =>
    declared === undefined ? Number.POSITIVE_INFINITY : Math.max(0, (declared.window - HELPER_REPLY_TOKENS) * CHARS_PER_TOKEN);

// Why a rung was not asked, in the words the owner can act on: what it would have taken, what the model accepts, and
// the two places either number is changed. Undefined means it fits.
export const helperOverflow = (prompt: string, room: number, declared: DeclaredWindow | undefined): string | undefined => {
    if (prompt.length <= room || declared === undefined) {
        return undefined;
    }
    const fix = declared.onACard
        ? `Raise "Conversation window" on this model's card in Connections`
        : `Raise the context size its server was started with`;
    return (
        `this job needs about ${withCommas(prompt.length / CHARS_PER_TOKEN)} tokens and the model accepts ` +
        `${withCommas(declared.window)} in one request. ${fix}, or set a model with a larger window for this job in ` +
        `Sandbox ▸ Agent ▸ Models.`
    );
};

export interface ContextShortfall {
    // What the server said it will accept; what the turn was measured against.
    readonly window: number;
    readonly needed: number;
    // The user-facing sentence: the three numbers, then the three things that change the answer.
    readonly message: string;
}

// Carries whether the window came from a card in this app (fixable here) or a user's own server (fixable only there),
// since the refusal's advice depends on which.
export interface DeclaredWindow {
    readonly window: number;
    readonly onACard: boolean;
}

// Declared window for endpoint providers only: a native subscription publishes none and is always huge, so the common
// case is one string comparison. The catalog read is cached, so this costs nothing extra.
// Resolved once per turn by the planner and handed to both readers of it — the trim that decides what to compose
// (context-trim.ts) and the refusal below — since two reads could disagree across a catalog refresh mid-plan.
// Two seams: which capability serves the provider, and what its catalog publishes for the resolved model.
export const declaredWindow = async (
    services: Pick<Services, "capabilities" | "endpointModels">,
    provider: AgentProvider,
    model: string | undefined,
): Promise<DeclaredWindow | undefined> => {
    const id = endpointIdOf(provider);
    // Trial publishes no window: its model id is synthetic, the real model is picked per message.
    if (id === undefined || isTrialProvider(provider)) {
        return undefined;
    }
    const capability = await services.capabilities.get(id);
    const config = capability === undefined ? undefined : endpointConfigOf(capability);
    if (config === undefined) {
        // Not an endpoint this sandbox holds; the credential resolver will refuse it by name a moment later.
        return undefined;
    }
    const catalog = await services.endpointModels.models(id, config);
    const resolved = routedModel(catalog, model);
    const window = catalog.models.find((entry) => entry.id === resolved)?.contextWindow;
    return window === undefined ? undefined : { window, onACard: capability?.kind === "localmodel" };
};

// Undefined means send it: either the window is unknown, or it fits the floor plus what was composed. `prompt` is
// counted as sent, notes and all, not just the user's words.
export const contextShortfall = (turn: {
    readonly runtime: AgentCapabilities["runtime"];
    // The window the planner already resolved (declaredWindow), so the check and the trim measure the same number.
    readonly declared: DeclaredWindow | undefined;
    readonly prompt: string;
}): ContextShortfall | undefined => {
    const floor = HARNESS_FLOOR_TOKENS[turn.runtime];
    if (floor === undefined || turn.declared === undefined) {
        return undefined;
    }
    const { window, onACard } = turn.declared;
    const promptTokens = Math.ceil(turn.prompt.length / CHARS_PER_TOKEN);
    const needed = floor + OUTPUT_RESERVE_TOKENS + promptTokens;
    if (needed <= window) {
        return undefined;
    }
    // Points at a sandbox card when this app can fix it, or a server flag when only the owner elsewhere can.
    const fix = onACard
        ? `Raise "Conversation window" on this model's card in Connections (each step up costs memory, the card ` +
          `prices it), pick a model with a larger window, or keep this one for the small jobs (titles, commit ` +
          `messages) it can do as a one-shot helper.`
        : `Raise the context size the server was started with, pick a model with a larger window, or keep this ` +
          `one for the small jobs (titles, commit messages) it can do as a one-shot helper.`;
    return {
        window,
        needed,
        message:
            `This model accepts ${withCommas(window)} tokens in one request and this turn needs about ` +
            `${withCommas(needed)}, so nothing was sent. Roughly ${withCommas(floor)} of that is the agent loop ` +
            `itself, its instructions and one definition per tool it can call, before your message ` +
            `(~${withCommas(promptTokens)}) and room to answer. ${fix}`,
    };
};
