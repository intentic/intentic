import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { instancesOf } from "@intentic/capability-catalog";
import { sleep } from "@intentic/base/async";
import type { CapabilityOffer, CapabilityStatus } from "@intentic/sandbox-contract";
import { type CardDeps, cardRun, OFFER_DEADLINE_MS, raiseCard, whyOf } from "../agent/run/offer-card.js";

// Setup gate: an agent asks the owner, in chat, to connect a missing capability; shaped like the wallet's payment gate.
// A yes watches the manifest and resumes the parked call once live; a no is remembered per-conversation.
// Frames are raised outside the turn generator, mirrored by hand, not journalled: the waiter is the CLI's connection.

// How long a yes stays parked for the connection; longer than the ask, since the owner is actively setting up.
const SETUP_DEADLINE_MS = 15 * 60_000;
// How often the watcher re-reads the manifest during setup.
const POLL_MS = 3_000;

// Terminal-shaped answer triple, the same shape the platform relays use, so the CLI prints it the same way.
export interface AskAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
}

// Manifest slice the card join reads (kind, config) plus the id to probe by; not CapabilitySummary, since probing every
// entry per poll would price the watch by manifest size.
export interface AskInstance {
    readonly id: string;
    readonly kind: string;
    readonly config: Record<string, string | number | boolean | undefined>;
}

export interface AskDeps extends CardDeps {
    // Every connectable card: static catalog merged with enabled extensions' contributed cards (connectable.ts).
    readonly cards: () => Promise<readonly CapabilityCatalogEntry[]>;
    // Manifest as it stands, cheap (no probes); the join to the asked card happens here.
    readonly list: () => Promise<readonly AskInstance[]>;
    // One instance's live status, probed only for the asked card's instances.
    readonly status: (instance: AskInstance) => Promise<CapabilityStatus>;
    // Test seams for the three clocks.
    readonly deadlineMs?: number;
    readonly setupDeadlineMs?: number;
    readonly pollMs?: number;
}

export interface AskedCapability {
    // Catalog card being asked for, as the agent named it.
    readonly card: string;
    readonly why: string | undefined;
    // Stamped from INTENTIC_TURN_OWNER; the two reserved owner names mean no conversation here.
    readonly conversationId: string | undefined;
    // Held CLI connection; aborting settles the card instead of leaving it parked on nothing.
    readonly signal: AbortSignal;
}

const answer = (status: number, body: unknown): AskAnswer => ({ status, body: JSON.stringify(body), contentType: "application/json" });
const refusal = (status: number, type: string, message: string): AskAnswer => answer(status, { error: { type, message } });

// One conversation's memory of its asks: parked blocks a second card while the first is up, declined holds a no.
// In-memory: a decline is scoped to its conversation, and a restart tears down the held CLI calls this describes
// anyway.
type AskState = "parked" | "declined";

export interface CapabilityGate {
    readonly ask: (asked: AskedCapability) => Promise<AskAnswer>;
}

export const createCapabilityGate = (deps: AskDeps): CapabilityGate => {
    const memory = new Map<string, Map<string, AskState>>();
    const stateOf = (conversationId: string, card: string): AskState | undefined => memory.get(conversationId)?.get(card);
    const remember = (conversationId: string, card: string, state: AskState | undefined): void => {
        const conversation = memory.get(conversationId) ?? new Map<string, AskState>();
        if (state === undefined) {
            conversation.delete(card);
        } else {
            conversation.set(card, state);
        }
        memory.set(conversationId, conversation);
    };

    // Asked card's live instances with their probed status, bounded by the card, not the whole manifest.
    const connectionsOf = async (entry: CapabilityCatalogEntry): Promise<{ instance: AskInstance; status: CapabilityStatus }[]> => {
        const instances = instancesOf(entry, await deps.list());
        return Promise.all(instances.map(async (instance) => ({ instance, status: await deps.status(instance) })));
    };

    // Watches the manifest until an instance reports active, the setup window closes, or the caller dies; answers the
    // connected instance or undefined for both other endings.
    const watchForConnection = async (entry: CapabilityCatalogEntry, signal: AbortSignal): Promise<AskInstance | undefined> => {
        const deadline = Date.now() + (deps.setupDeadlineMs ?? SETUP_DEADLINE_MS);
        for (;;) {
            const connections = await connectionsOf(entry);
            const active = connections.find((connection) => connection.status.state === "active");
            if (active !== undefined) {
                return active.instance;
            }
            if (signal.aborted || Date.now() >= deadline) {
                return undefined;
            }
            await sleep(deps.pollMs ?? POLL_MS, { signal });
        }
    };

    const ask = async (asked: AskedCapability): Promise<AskAnswer> => {
        const run = cardRun(deps, asked.conversationId);
        if (run === undefined) {
            return refusal(
                409,
                "no_conversation",
                "A capability ask needs a live conversation to raise its card in, and none could be found. Nothing was connected.",
            );
        }
        // Catalog is the card's whole factual content: a name it doesn't hold is a sentence, never a card.
        const cards = await deps.cards();
        const entry = cards.find((candidate) => candidate.id === asked.card);
        if (entry === undefined) {
            return refusal(404, "unknown_capability", `No capability card is named "${asked.card}": \`capabilities list\` names what exists.`);
        }
        // Already connected means no card: "use it" beats a question to shrug at; an inactive instance still gets
        // asked.
        const connections = await connectionsOf(entry);
        const active = connections.find((connection) => connection.status.state === "active");
        if (active !== undefined) {
            return answer(200, {
                connected: true,
                id: active.instance.id,
                message: `${entry.name} is already connected as "${active.instance.id}", use it.`,
            });
        }
        switch (stateOf(run.conversationId, entry.id)) {
            case "parked":
                return refusal(409, "already_asked", `You already asked for ${entry.name}: that card is still up; wait for its answer.`);
            case "declined":
                return refusal(403, "declined", `The owner already skipped connecting ${entry.name} in this conversation: continue without it.`);
            case undefined:
                break;
        }
        const offer: CapabilityOffer = {
            card: entry.id,
            name: entry.name,
            ...whyOf(asked.why),
        };
        remember(run.conversationId, entry.id, "parked");
        const card = await raiseCard(deps, run, {
            kind: "capability_offer",
            onAbort: { kind: "capability_offer", requestId: "", connect: false },
            raised: (requestId) => ({ kind: "capability_offer", requestId, offer }),
            signal: asked.signal,
            deadlineMs: deps.deadlineMs ?? OFFER_DEADLINE_MS,
        });
        if (!card.reply.connect) {
            // Two different no's, told apart by whether a person actually answered (offer-card.ts argues why).
            if (!card.answered) {
                remember(run.conversationId, entry.id, undefined);
                return refusal(
                    408,
                    "unanswered",
                    `The ask went unanswered and expired: nothing was connected. Continue without ${entry.name}; ask again only if the owner shows up.`,
                );
            }
            remember(run.conversationId, entry.id, "declined");
            return refusal(
                403,
                "declined",
                `The owner skipped connecting ${entry.name}: continue without it, and say plainly what it would have enabled. Don't ask for it again in this conversation.`,
            );
        }
        // Owner said yes, setting up: hold the call and watch; the outcome frame below settles the card everywhere.
        const connected = await watchForConnection(entry, asked.signal);
        remember(run.conversationId, entry.id, undefined);
        card.say(
            connected !== undefined
                ? { kind: "capability_outcome", requestId: card.requestId, outcome: "connected", id: connected.id }
                : { kind: "capability_outcome", requestId: card.requestId, outcome: "unfinished" },
        );
        if (connected === undefined) {
            return refusal(
                408,
                "unfinished",
                `The owner accepted, but the setup didn't finish while you waited. Continue what you can without ${entry.name}; it may come live later: check with \`capabilities list\` before asking again.`,
            );
        }
        return answer(200, {
            connected: true,
            id: connected.id,
            message: `${entry.name} is connected as "${connected.id}", its skill and tools are available from your next tool call. Continue the task with it.`,
        });
    };

    return { ask };
};
