import { failureFingerprint } from "@intentic/sandbox-contract/policy/failure-codes";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { track } from "../../app/analytics";
import { type AgentStanding, turnInFlight } from "./agentStatus-standing";
import type { WayOut, WayOutKind } from "../conversations/endings/wayOut";

/* HOW OFTEN A TURN FAILS, AND WHETHER THE WAY OUT WORKED. Observed from the server's summaries, not from what a window
   renders, so a failure is counted once however many cards, panes and windows draw it. Only categories and counts leave
   the editor: a failure's words can hold a path, a command or the person's own message, so they are read here (to tell
   one failure from the next) and never sent. */

type Properties = Readonly<Record<string, string | number | boolean>>;
type Capture = (event: string, properties: Properties) => void;

/** The card's facts these events are read off: its standing, and how many times in a row it failed the same way. */
export type FailureCard = AgentStanding & Pick<AgentSummary, `id` | `updatedAt`> & Partial<Pick<AgentSummary, `failureRepeats`>>;

// A way out somebody took, waiting for the conversation it led to (the new one, or this one again) to run and settle.
interface Pending {
    readonly way: WayOutKind;
    // When the card last moved as the way was taken: a card that moves past it has settled on what the way started. Absent
    // for a conversation with no card yet (a new one), whose first card after a run is the answer.
    readonly since: number | undefined;
    ran: boolean;
}

// Ways out waiting on an answer, oldest first; one nobody ran is forgotten once this many newer ones are waiting.
const PENDING_KEPT = 32;

const keyOf = (sandbox: string | undefined, id: string): string => JSON.stringify([sandbox, id]);

// Which failure this is: the same failure come back again counts again, since its count moved.
const signatureOf = (card: FailureCard): string => JSON.stringify([failureFingerprint(card.failureCode, card.failure), card.failureRepeats ?? 1]);

export const createTurnFailureTelemetry = (capture: Capture) => {
    const failed = new Map<string, string>();
    const shown = new Set<string>();
    const pending = new Map<string, Pending>();

    // The way taken for this card, answered once it has run and settled: well where it did not end on a failure.
    const settle = (key: string, card: FailureCard): void => {
        const waiting = pending.get(key);
        if (waiting === undefined) {
            return;
        }
        if (turnInFlight(card)) {
            waiting.ran = true;
            return;
        }
        const moved = waiting.since === undefined ? card.status !== `idle` : card.updatedAt > waiting.since;
        if (waiting.ran || moved) {
            pending.delete(key);
            capture(`way_out_outcome`, { way: waiting.way, ok: card.status !== `error` });
        }
    };

    return {
        /** Every summary the roster brings: a failure counted once per distinct failure, and a way out's answer. */
        observe: (card: FailureCard, sandbox: string | undefined): void => {
            const key = keyOf(sandbox, card.id);
            settle(key, card);
            if (card.status !== `error`) {
                failed.delete(key);
                return;
            }
            const signature = signatureOf(card);
            if (failed.get(key) === signature) {
                return;
            }
            failed.set(key, signature);
            capture(`turn_failed`, { code: card.failureCode ?? `uncoded`, repeats: card.failureRepeats ?? 1 });
        },
        /** A way out drawn for a failure: once per failure, whichever pane or window drew it. */
        shown: (card: FailureCard, sandbox: string | undefined, wayOut: WayOut): void => {
            const key = JSON.stringify([sandbox, card.id, signatureOf(card)]);
            if (shown.has(key)) {
                return;
            }
            shown.add(key);
            capture(`way_out_shown`, { layer: wayOut.layer, recommended: wayOut.recommended, repeats: wayOut.repeats });
        },
        /** A way out pressed, and the conversation it leads to, whose next settled run answers whether it worked. */
        taken: (way: WayOutKind, wayOut: WayOut, to: { readonly sandbox: string | undefined; readonly id: string; readonly since: number | undefined }): void => {
            capture(`way_out_taken`, { way, recommended: way === wayOut.recommended, layer: wayOut.layer });
            const key = keyOf(to.sandbox, to.id);
            pending.delete(key);
            pending.set(key, { way, since: to.since, ran: false });
            const overflow = [...pending.keys()].slice(0, Math.max(0, pending.size - PENDING_KEPT));
            for (const old of overflow) {
                pending.delete(old);
            }
        },
    };
};

export const turnFailureTelemetry = createTurnFailureTelemetry(track);
