import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import { instancesOf } from "@intentic-app/capability-catalog";
import { sleep } from "@intentic/base/async";
import type { AgentEvent, CapabilityOffer, CapabilityStatus } from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import { DAEMON_OWNER, ONE_SHOT_OWNER } from "../platform/leftovers.js";

/* THE SETUP GATE, how an agent asks the owner to connect a capability it is missing, mid-task, in chat.
 *
 * The shape is the spend gate's (platform/service-offer.ts), because the trust problem is the same: the model
 * may ASK, and only the owner's click makes anything happen. The agent's `capabilities request` call PARKS
 * here, a card goes up in the conversation's live turn with the CATALOG's own words on it (the card id and
 * title come from the catalog the ask was validated against, the model contributes its one-line `why` and
 * nothing else), and the call is answered by how the card settles. A prompt-injected model can ask; it cannot
 * connect anything, and it cannot make the card say the capability is something it is not.
 *
 * WHAT "YES" MEANS is the one place this gate differs from the spend gate: a click does not perform the setup
 *, connecting is the owner's own flow, on the Capabilities page the card hands them to. So a yes keeps the
 * agent's call parked while the gate WATCHES the manifest for the capability to come live, and the agent
 * resumes in the same turn the moment it does, which is the entire point of asking in chat rather than
 * describing manual steps. A no answers immediately, and is remembered for the conversation so a repeat ask
 * is answered without a second card: "don't nag" is plumbing here, not etiquette.
 *
 * Frames are raised from OUTSIDE the turn generator (the agent's CLI call arrives as an HTTP request while
 * the turn sits inside its Bash tool), pushed into the live run's frame log and mirrored to the registry by
 * hand, like the spend gate, and for the same reason the card is not journalled for restore: the waiter is
 * the CLI's held connection, which dies with the daemon. */

// How long an unanswered ask holds the agent's call before settling as "nobody answered", the spend gate's
// window, for the spend gate's reason.
const ASK_DEADLINE_MS = 10 * 60_000;
// How long a YES keeps the call parked waiting for the connection to come live. Longer than the ask window on
// purpose: the owner is now actively setting something up (finding a token, signing in, maybe a 2FA round
// trip), and expiring under them turns their work into a message nobody was waiting for.
const SETUP_DEADLINE_MS = 15 * 60_000;
// How often the watcher re-reads the manifest while a setup is underway.
const POLL_MS = 3_000;

// The agent's why, capped, one line of rationale is the card's design, not a second prompt.
const WHY_MAX = 280;

// What the ask answers with, the same terminal-shaped triple the platform relays use, so the CLI prints it
// the same way `services` prints the platform's.
export interface AskAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
}

// The manifest slice the card join reads (kind + config), plus the id a watcher probes by. Deliberately not
// CapabilitySummary: a status probe per manifest entry per poll would price the watch by the size of the
// manifest, when only the asked card's own instances ever need probing.
export interface AskInstance {
    readonly id: string;
    readonly kind: string;
    readonly config: Record<string, string | number | boolean | undefined>;
}

export interface AskDeps {
    // Every card that can be connected here, the static catalog merged with the enabled extensions'
    // contributed cards (connectable.ts). What the ask is validated against, and where the card's title
    // comes from.
    readonly cards: () => Promise<readonly CapabilityCatalogEntry[]>;
    // The manifest as it stands, cheap (no probes); the join to the asked card is done here.
    readonly list: () => Promise<readonly AskInstance[]>;
    // One instance's live status, probed only for instances of the asked card.
    readonly status: (instance: AskInstance) => Promise<CapabilityStatus>;
    // The live turn the card lands in: the named conversation's run, or, when the caller could not name one,
    // the sole live run. Undefined refuses the ask outright.
    readonly liveRun: (
        conversationId: string | undefined,
    ) => { readonly conversationId: string; readonly push: (event: AgentEvent) => void } | undefined;
    // The registry's frame observer, externally pushed frames bypass the turn pump that usually feeds it, so
    // the gate mirrors its own frames there to light and clear the Attention lane.
    readonly observe: (conversationId: string, event: AgentEvent) => void;
    // Test seams for the three clocks.
    readonly deadlineMs?: number;
    readonly setupDeadlineMs?: number;
    readonly pollMs?: number;
}

export interface AskedCapability {
    // The catalog card being asked for, as the agent named it.
    readonly card: string;
    readonly why: string | undefined;
    // The conversation the calling shell was stamped with (INTENTIC_TURN_OWNER); the two reserved owner names
    // are "no conversation" here.
    readonly conversationId: string | undefined;
    // The held CLI connection, aborts when the agent's command dies, which settles the card instead of
    // leaving it parked in a conversation nothing waits behind.
    readonly signal: AbortSignal;
}

const answer = (status: number, body: unknown): AskAnswer => ({ status, body: JSON.stringify(body), contentType: "application/json" });
const refusal = (status: number, type: string, message: string): AskAnswer => answer(status, { error: { type, message } });

/* One conversation's memory of its asks. `parked` prevents a second card for a capability whose first card is
 * still up; `declined` is the owner's no, held for the conversation so a repeat ask is answered without
 * bothering them again. In-memory on purpose: a decline is scoped to the conversation it happened in, and a
 * daemon restart tears down the held CLI calls this state describes anyway. */
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

    // The asked card's live instances, each with its probed status, bounded by the card, not the manifest.
    const connectionsOf = async (entry: CapabilityCatalogEntry): Promise<{ instance: AskInstance; status: CapabilityStatus }[]> => {
        const instances = instancesOf(entry, await deps.list());
        return Promise.all(instances.map(async (instance) => ({ instance, status: await deps.status(instance) })));
    };

    // Watch the manifest until an instance of the card reports active, the setup window closes, or the caller
    // dies. Answers the connected instance, or undefined for both endings that connected nothing.
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
        const named = asked.conversationId === DAEMON_OWNER || asked.conversationId === ONE_SHOT_OWNER ? undefined : asked.conversationId;
        const run = deps.liveRun(named);
        if (run === undefined) {
            return refusal(
                409,
                "no_conversation",
                "A capability ask needs a live conversation to raise its card in, and none could be found. Nothing was connected.",
            );
        }
        // The catalog is the card's whole factual content: an ask that names nothing in it is a sentence, not
        // a card, and never a card titled with the model's own words.
        const cards = await deps.cards();
        const entry = cards.find((candidate) => candidate.id === asked.card);
        if (entry === undefined) {
            return refusal(404, "unknown_capability", `No capability card is named "${asked.card}": \`capabilities list\` names what exists.`);
        }
        /* Already connected ⇒ no card: the answer the agent actually wants ("use it") beats a question the
         * owner can only shrug at. Asking reflexively is therefore safe. An instance that exists but is not
         * active (a browser account never signed in, an errored connector) does NOT short-circuit, finishing
         * its setup is exactly what the card asks for. */
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
            ...(asked.why !== undefined && asked.why !== "" ? { why: asked.why.slice(0, WHY_MAX) } : {}),
        };
        const { id, wait } = createRequest("capability_offer", { kind: "capability_offer", requestId: "", connect: false }, run.conversationId);
        remember(run.conversationId, entry.id, "parked");
        const raised: AgentEvent = { kind: "capability_offer", requestId: id, offer };
        run.push(raised);
        deps.observe(run.conversationId, raised);
        const { reply, resolved } = await wait(AbortSignal.any([asked.signal, AbortSignal.timeout(deps.deadlineMs ?? ASK_DEADLINE_MS)]));
        run.push(resolved);
        deps.observe(run.conversationId, resolved);
        if (!reply.connect) {
            /* Two different no's, told apart by whether a person actually answered: a resolved frame with no
             * reply is the abort stand-in (the deadline fired, or the CLI died under the card), and reading
             * that as "the owner declined" would put words in the mouth of somebody who never saw the card. */
            if (resolved.reply === undefined) {
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
        /* The owner said yes and is setting it up, hold the call and watch for the connection. The card's
         * "waiting for setup" state lives on this watch: the outcome frame below is what settles it, on this
         * surface and every other one. */
        const connected = await watchForConnection(entry, asked.signal);
        remember(run.conversationId, entry.id, undefined);
        const outcome: AgentEvent =
            connected !== undefined
                ? { kind: "capability_outcome", requestId: id, outcome: "connected", id: connected.id }
                : { kind: "capability_outcome", requestId: id, outcome: "unfinished" };
        run.push(outcome);
        deps.observe(run.conversationId, outcome);
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
