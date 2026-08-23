import { type AgentCapabilities, type AgentProvider, endpointIdOf, isTrialProvider } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { endpointConfigOf } from "../endpoints/local-model.js";
import { routedModel } from "./harness-credentials.js";

/* CAN THIS MODEL HOLD A TURN OF THIS AGENT LOOP AT ALL, asked before anything is sent.
 *
 * WHAT THIS EXISTS TO STOP. A sandbox-run 3B model, 16,384 tokens of served context, was picked in the composer
 * and sent "Are you there?". The reply was `400 request (49181 tokens) exceeds the available context size
 * (16384 tokens)`: the model never saw the two words, and the only component in the whole stack that knew the
 * total was llama.cpp's own request validator. Every layer above it had done its job correctly. The turn
 * preamble held its 2,800 characters, the retrieved-context capsule held its 1,200 tokens, the system prompt was
 * its usual ~2.3k, and none of that mattered, because the ~45k the harness itself sends (its own instructions
 * plus one JSON schema per exposed tool, times every connected capability) is not something a note budget can
 * shrink.
 *
 * SO THE CHECK IS A FLOOR, NOT A DIET. Trimming what the daemon writes cannot make a 16k window work; the honest
 * answer is that this loop does not run there, said before the message is spent rather than after. What the user
 * gets is the three numbers and the three things that change the outcome.
 *
 * WHY IT IS SAFE TO BE APPROXIMATE. The floor below is deliberately LOWER than any measurement we have, so the
 * check errs towards letting a turn through: a doomed turn that gets sent fails exactly as it does today, while
 * a refusal handed to a window that would have served is a regression we would have invented. Nothing here
 * guesses upward, and nothing here refuses a window it was never told about (`contextWindow` absent ⇒ no gate). */

/* THE HARNESS'S OWN FIXED COST, per runtime, in tokens, and the one number in this file that is an estimate.
 *
 * It cannot be computed here: the daemon composes the prompt, and the harness then adds its own instructions and
 * its tool schemas downstream, so the only true measurement is the input-token count on a result frame, which
 * exists only for turns that already succeeded. What the one measurement we have says: an opening turn on the
 * Claude Code loop, in a sandbox with browsers, two connected computers and the usual servers mounted, billed
 * 49,181 tokens against ~3.5k of composed preamble.
 *
 * 20k claims only the ALWAYS-ON part of that: the loop's own instructions, its built-in tool schemas, and the
 * servers every turn in this sandbox mounts whatever the owner has connected. Everything above it varies with
 * the capability list, which is exactly why this constant does not try to name it: a lean sandbox must not be
 * refused a window it could have used. The turns that slip through are caught where they always were, by the
 * provider, and calibrating this per (runtime, tool set) off the first successful turn is the next step.
 *
 * A runtime absent from this map is one nothing has measured, and an unmeasured floor gates nothing. */
const HARNESS_FLOOR_TOKENS: Partial<Record<AgentCapabilities["runtime"], number>> = { "claude-code": 20_000 };

// Room for the answer. A model that can accept the request and not finish a sentence has not run the turn, and
// the harness's own retry on a truncated reply spends the whole window again.
const OUTPUT_RESERVE_TOKENS = 2_000;

// The rough rate every budget in this daemon counts at (workspace-map.ts, runtime-history.ts). Good to ~10% on
// prose and code alike, which is well inside the margin a 20k floor estimate already carries.
const CHARS_PER_TOKEN = 4;

const withCommas = (value: number): string =>
    Math.round(value)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");

export interface ContextShortfall {
    // What the server said it will accept, and what the turn was measured against.
    readonly window: number;
    readonly needed: number;
    // The user's sentence: three numbers, then the three things that change the answer.
    readonly message: string;
}

/* WHOSE WINDOW IT IS, carried beside the number because it decides what the refusal may ASK FOR.
 *
 * A user-added endpoint is a server the owner started somewhere with flags only they can reach, so the honest
 * advice there is "raise the context size the server was started with". A sandbox-run local model is a card in
 * this app with that number on it, and telling its owner to go edit a command line they never typed is telling
 * them to fix it somewhere it cannot be fixed. Same arithmetic, same three numbers, one sentence that has to
 * know which of the two it is talking to. */
interface DeclaredWindow {
    readonly window: number;
    readonly onACard: boolean;
}

/* THE DECLARED WINDOW for the model a turn is about to dial, or undefined when nothing published one.
 *
 * Endpoint providers only, which is not a shortcut but the whole set of models this can answer for: an
 * `endpoint/<id>` provider (a user's own server, or a sandbox-run local model) is the one place a served window
 * is discoverable, because we ask the server itself (endpoints/endpoint-catalog.ts). A native subscription
 * publishes no such number and every model it offers is a 200k-class window anyway, so the common path pays one
 * string comparison and stops.
 *
 * The catalog read is cached (a minute's TTL, persisted last-known-good), and the credential resolution that
 * follows a permitted turn reads the same cached answer, so this costs the turn nothing it was not already
 * paying. */
const declaredWindow = async (services: Services, provider: AgentProvider, model: string | undefined): Promise<DeclaredWindow | undefined> => {
    const id = endpointIdOf(provider);
    /* THE TRIAL IS AN ENDPOINT AND STILL ANSWERS NO CATALOG READ, deliberately, the same rule its credential
     * resolution follows and for the same reason (harness-credentials.ts): everything about it is a constant, the
     * model id is synthetic, the platform picks the real model per message, and the window is therefore not a
     * thing the trial could publish. Asking anyway would buy nothing and sell the failure that rule exists to
     * prevent, a platform blip at plan time turning into a refused turn. */
    if (id === undefined || isTrialProvider(provider)) {
        return undefined;
    }
    const capability = await services.capabilities.get(id);
    const config = capability === undefined ? undefined : endpointConfigOf(capability);
    if (config === undefined) {
        // Not an endpoint this sandbox holds. The credential resolver refuses it by name a moment later; saying
        // anything about a window here would be answering for a server that does not exist.
        return undefined;
    }
    const catalog = await services.endpointModels.models(id, config);
    const resolved = routedModel(catalog, model);
    const window = catalog.models.find((entry) => entry.id === resolved)?.contextWindow;
    return window === undefined ? undefined : { window, onACard: capability?.kind === "localmodel" };
};

/* Whether this turn fits, and the refusal when it does not. Undefined means "send it": either the window is
 * unknown, or it is big enough for the floor plus what we composed.
 *
 * `prompt` is the turn's message AS COMPOSED, notes and all, because that is what will be sent. Counting the
 * user's words alone would under-read exactly the turns that carry the most (an opening message, which is the
 * one that gets the project map and the retrieved-context capsule). */
export const contextShortfall = async (
    services: Services,
    turn: {
        readonly provider: AgentProvider;
        readonly runtime: AgentCapabilities["runtime"];
        readonly model: string | undefined;
        readonly prompt: string;
    },
): Promise<ContextShortfall | undefined> => {
    const floor = HARNESS_FLOOR_TOKENS[turn.runtime];
    if (floor === undefined) {
        return undefined;
    }
    const declared = await declaredWindow(services, turn.provider, turn.model);
    if (declared === undefined) {
        return undefined;
    }
    const { window, onACard } = declared;
    const promptTokens = Math.ceil(turn.prompt.length / CHARS_PER_TOKEN);
    const needed = floor + OUTPUT_RESERVE_TOKENS + promptTokens;
    if (needed <= window) {
        return undefined;
    }
    /* THE WAY OUT IS NAMED WHERE IT ACTUALLY IS. For a model this sandbox runs itself that is a field on its
     * card, one the owner can raise in ten seconds, so it leads: it is both the cheapest fix and the one they
     * would never have found from a message about tokens. For somebody else's server it is a flag on a process
     * we cannot see, and pretending otherwise would send them looking for a control that isn't there. */
    const fix = onACard
        ? `Raise "Conversation window" on this model's card in Connections (each step up costs memory, the card ` +
          `prices it), pick a model with a larger window, or keep this one for the small jobs (titles, commit ` +
          `messages) it can do as a quick model.`
        : `Raise the context size the server was started with, pick a model with a larger window, or keep this ` +
          `one for the small jobs (titles, commit messages) it can do as a quick model.`;
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
