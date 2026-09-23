import type { AgentEvent } from "@intentic/sandbox-contract";
import { withCacheTtl } from "../turn/prompt-cache.js";
import type { TurnFrames } from "./frame-reducers.js";

// A frame's rewrites on its way from the runtime to the stream: pure per-frame functions, and the one stream-level
// insertion, the failure a silent ending gets ahead of `done`. Failure frames take their dressing from
// classify-failure.ts instead.

// Who served and who asked, stamped onto every frame that answers "whose account" so no two sites can disagree.
export interface Attribution {
    readonly account?: string;
    readonly actor?: string;
}

// The frames a reader keys by account: the session a turn is on, what it cost, and the allowance it read.
const ATTRIBUTED: ReadonlySet<AgentEvent["kind"]> = new Set(["session", "usage", "rate_limit_info", "account_usage"]);

export const stampAttribution = (event: AgentEvent, attribution: Attribution): AgentEvent => (ATTRIBUTED.has(event.kind) ? { ...event, ...attribution } : event);

// The stream can only measure a TTL from a request that wrote cache; the credential's own rule finishes a frame carrying
// just the instant, so every reader downstream sees the same deadline.
export const completeCacheTtl = (event: AgentEvent, provider: string, oauth: boolean): AgentEvent =>
    event.kind === "context_usage" ? withCacheTtl(event, provider, oauth) : event;

// Every rewrite a frame other than a failure takes on its way out.
export const decorateFrame = (event: AgentEvent, turn: { readonly attribution: Attribution; readonly provider: string; readonly oauth: boolean }): AgentEvent =>
    completeCacheTtl(stampAttribution(event, turn.attribution), turn.provider, turn.oauth);

// An abort is not a failure, said once here: every adapter reports it like a real death.
export const abortSuppresses = (event: AgentEvent, aborted: boolean): boolean => event.kind === "error" && aborted;

// Cards a turn can park on, meaning it addressed the user; prose counts too, a tool call doesn't.
const ADDRESSED_FRAMES: readonly AgentEvent["kind"][] = ["plan", "question", "permission", "capability_offer", "payment_offer", "browser_help", "terminal_help"];

// What judging a silent ending reads, gathered at the `done` frame where every field is final.
export interface TurnSilence {
    readonly conversationId: string | undefined;
    readonly aborted: boolean;
    readonly failed: boolean;
    // Whether the provider spoke at all: worked-and-told-nobody counts as this; never-started does not.
    readonly answered: boolean;
    // Every frame kind emitted; what counts as addressing the user is decided from this set, in one place.
    readonly kinds: ReadonlySet<AgentEvent["kind"]>;
    readonly proseChars: number;
    readonly filesEdited: number;
    readonly toolCalls: number;
}

// The turn as a silent ending judges it, from its readings and ledgers at the moment it is asked.
export const silenceOf = (
    frames: Pick<TurnFrames, "readings" | "verification" | "metrics">,
    turn: { readonly conversationId: string | undefined; readonly aborted: boolean },
): TurnSilence => {
    const { failure, silence } = frames.readings();
    return {
        ...turn,
        failed: failure !== undefined,
        ...silence,
        filesEdited: frames.verification.edited().length,
        toolCalls: frames.metrics.calls(),
    };
};

// Whether this turn put anything in front of the person who asked: prose, or a card it parked on.
const addressedUser = (turn: TurnSilence): boolean => turn.proseChars > 0 || ADDRESSED_FRAMES.some((kind) => turn.kinds.has(kind));

// The sentence for a turn that ended with nothing to show for itself, otherwise indistinguishable from a finished one.
// Excludes an edited turn, one never answered, one the user stopped, and one that already failed.
export const silentEnding = (turn: TurnSilence): string | undefined => {
    if (turn.conversationId === undefined || turn.aborted || turn.failed || !turn.answered) {
        return undefined;
    }
    if (turn.filesEdited > 0 || addressedUser(turn)) {
        return undefined;
    }
    // Tool calls mean the turn got somewhere before stopping; none means it never got past its first thought.
    const did =
        turn.toolCalls === 0 ? "the model started and then stopped" : `${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"} and then a stop`;
    return `The turn ended with nothing to show for it: ${did}, no reply and no change to a file. Nothing failed: the session is intact, so carrying on continues from where it stopped.`;
};

// Injected ahead of `done`, so a silent ending runs the same path a provider failure does (activity, log, ledger,
// Attention). `silent` is a callback since its state is only final once the stream is.
export async function* withSilentEnding(frames: AsyncIterable<AgentEvent>, silent: () => string | undefined): AsyncGenerator<AgentEvent> {
    for await (const event of frames) {
        if (event.kind === "done") {
            const message = silent();
            if (message !== undefined) {
                // Uncoded on purpose: it lets the chat answer with a Continue press, not a dead end.
                yield { kind: "error", message };
            }
        }
        yield event;
    }
}
