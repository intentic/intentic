import type { AgentSummary, AutomationApproval } from "@intentic/sandbox-contract";
import { ref, shallowRef, watch } from "vue";
import { invalidateAgentTranscript } from "../chat/agentTranscript";
import { useChat } from "../chat/useChat";
import { reportClient } from "../clientDiagnostics";
import { reloadOnHotUpdate } from "../hotReload";
import { onScreen } from "../onScreen";
import { AGENT_DIFF } from "../queryKeys";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useSandbox } from "../sandbox/useSandbox";
import type { FleetAgent } from "./useAgents-fleet";

/* The daemon's agent registry, mirrored: the roster the /events stream pushes and the archived half the board
 * pulls, with the revision line that orders their snapshots. The bottom of the fleet store's module graph
 * (useAgents.ts maps it): everything here is state and the writes that keep it true to one daemon, and nothing
 * here reads a module above it at runtime (the one import from above, FleetAgent, is a type), so any of them can
 * import this one without a cycle. */

// shallowRef, for the same reason Conversation.state is: every write below REPLACES this array (a roster is a
// snapshot, never a patch, see the ordering note beneath), so there is no in-place mutation for deep
// reactivity to observe. A deep ref would instead re-proxy every summary in the fleet on each snapshot, and the
// daemon re-frames the roster about once a second for every running turn, so the board's cost scaled with
// agents × turns × their fields, which is exactly when the /agents view was reported to get sticky.
export const registry = shallowRef<AgentSummary[]>([]);

// The OTHER half of the fleet, the agents filed away. Declared here, beside the roster it is the counterpart
// of, because `fleet` reads it: an archived session whose tab holds unsent words is lifted back onto the board.
// When it is read, and why it is pull-only rather than streamed, is with loadArchived below; what archiving is,
// and what it takes with it, opens useAgents-archive.ts.
//
// shallowRef for the roster's reason, which applies here twice over: every write below REPLACES this array, and
// this is the half that GROWS WITHOUT BOUND, the board's live roster is bounded by what the user is working
// on, while the archive is everything they ever finished. A deep ref re-proxied every filed-away summary on
// each write, so opening the archive on a fleet with a thousand sessions in it paid for a thousand proxies
// before it drew anything.
export const archived = shallowRef<FleetAgent[]>([]);
export const archiveLoading = ref(false);

/* The wakes HELD at the door, the daemon's approvals queue, projected onto the board so "waiting for you"
 * sits beside "running" instead of in a page nobody opens. Separate state from the roster on purpose: the
 * /events stream repaints `registry` and knows nothing of holds, so a stream frame must not clobber this.
 * Pull-fed by refresh() (board mount, the reachable seam, pull-to-refresh) and by the approve/reject actions
 * below, a hold appearing while the board sits open lands on the next pull.
 *
 * Declared up here rather than beside those actions for two reasons: `attention` counts it, the rail's badge
 * is the only thing that can tell an owner a wake is waiting while they are anywhere else in the app, and
 * `desync` drops it, which is what keeps one sandbox's held wakes out of another sandbox's count. */
export const heldWakes = shallowRef<AutomationApproval[]>([]);

/* --- Roster ordering ----------------------------------------------------------------------------------------
 * The fleet is published as full snapshots, and THREE sources produce them: the /events stream, an explicit
 * refresh() (GET /agents), and this browser's own optimistic archive/restore. A plain full-replace lets whichever
 * lands last win regardless of when it was TRUE, which is what put an archived card back on the board and
 * bounced the user off its detail page.
 *
 * So every snapshot carries the registry revision it was read at (see AgentsListSchema), and:
 *   - a snapshot older than the one already applied is dropped outright; and
 *   - a local add/remove is held as a pending intent until a snapshot at or past the revision that APPLIED it
 *     arrives, at which point the server's own account is authoritative and the intent retires itself.
 *
 * The second rule is what a revision alone can't do: between sending an archive and the daemon applying it, an
 * unrelated change (a running turn ticks updatedAt about once a second) legitimately produces a NEWER snapshot
 * that still contains the agent. Dropping by revision would accept it; the pending intent is what keeps the card
 * off the board across that window. */

// The highest revision applied so far. -1 until the first snapshot: a fresh connection adopts whatever it is
// handed, including revision 0 from a daemon that just restarted.
let appliedRev = -1;

/* WHICH CONNECTION THE REVISION LINE BELONGS TO. The counter above is only comparable within one daemon
 * PROCESS, it lives in that process's memory and starts again at 0 when it restarts, so every reset of it
 * (desync, which the hello frame of every connection performs) opens a new line, and reads issued against the
 * old one must not land on the new. A GET /agents that left before a rebuild and answers after it carries the
 * old daemon's high-water number, and applying it would re-poison the guard the reset had just cleared: the
 * new daemon's every snapshot would be dropped as "older than what we have", which is the freeze this whole
 * mechanism exists to avoid. Reads capture the epoch they were issued in and drop their own answer if it
 * moved; frames need no such check, because a frame IS its connection. */
let epoch = 0;

// Ids this browser has locally added to or removed from the board, each held until `untilRev` is applied.
// `present` is the summary to show for a restore; a removal carries none.
interface PendingMove {
    readonly untilRev: number;
    readonly present?: AgentSummary;
}
const pending = new Map<string, PendingMove>();

// Project a server snapshot through the still-unconfirmed local moves.
const withPending = (agents: AgentSummary[]): AgentSummary[] => {
    if (pending.size === 0) {
        return agents;
    }
    const kept = agents.filter((agent) => !pending.has(agent.id));
    const restored = [...pending.values()].flatMap((move) => (move.present === undefined ? [] : [move.present]));
    return [...kept, ...restored];
};

// Every conversation in this roster is one the fleet KNOWS, so its open tab is no longer a draft, latched on
// the conversation (see Conversation.registered) rather than re-derived from the roster, because the whole
// point is to outlive the entry: archiving takes it off the roster, and so does a dropped stream.
// Latched off the server's own list, before the pending projection: a snapshot that still carries an agent
// this browser has locally archived is nonetheless proof the daemon registered it.
const latchRegistered = (agents: readonly AgentSummary[]): void => {
    const known = new Set(agents.map((agent) => agent.id));
    for (const conversation of useChat().conversations.value) {
        if (known.has(conversation.conversationId)) {
            conversation.registered.value = true;
        }
    }
};

/* Reuse the previous roster entry when a snapshot frame changed nothing about that agent. The daemon re-frames
 * the roster about once a second per running turn; without this every frame replaces the array and re-proxies
 * every summary, and the /agents board re-renders every card to tick one elapsed readout.
 *
 * BOTH SIDES ARE FINGERPRINTED EVERY FRAME, and the cached one's string is deliberately NOT kept beside it.
 * That reads as paying for the comparison twice, and it is the one thing here that must not be tidied away:
 * the optimistic writes (markSeen below; rename, setAutoLand, setResumeAfterOutage/Limit and stopWatching in
 * useAgents-actions) put their
 * field into the held entry IN PLACE, because `registry` is a deep ref and the in-place write is what repaints
 * every surface on the tick of the click. A stored fingerprint would then describe the entry as it was BEFORE
 * that write, so the next frame carrying the server's own value would compare equal to a string nothing holds
 * any more, hand back the locally-mutated object, and leave the board showing an optimistic value the daemon
 * had already refused: silently, and for as long as that field never changed again. Re-deriving it from the
 * cached object reads what the object actually says now, so an intent the server declines self-heals on the
 * next frame. Measured at 0.9ms per frame for a 200-agent roster, which is the price of that guarantee. */
export const snapshotFingerprint = (value: unknown): string => JSON.stringify(value);

const registryStable = new Map<string, AgentSummary>();

const stabilizeRegistry = (incoming: readonly AgentSummary[]): AgentSummary[] => {
    const nextIds = new Set<string>();
    const stabilized = incoming.map((agent) => {
        nextIds.add(agent.id);
        const cached = registryStable.get(agent.id);
        if (cached !== undefined && snapshotFingerprint(cached) === snapshotFingerprint(agent)) {
            return cached;
        }
        registryStable.set(agent.id, agent);
        return agent;
    });
    for (const id of registryStable.keys()) {
        if (!nextIds.has(id)) {
            registryStable.delete(id);
        }
    }
    return stabilized;
};

// Element-wise identity: does a stabilized array hold exactly the objects the previous one did? True means the
// frame changed nothing and the ref (and every reader of it) is left alone. Generic because the fleet memo one
// level up (useAgents-fleet) asks the same question of its card view-models.
export const sameEntries = <T>(left: readonly T[], right: readonly T[]): boolean =>
    left.length === right.length && left.every((entry, at) => entry === right[at]);

// Retire every intent the server has now demonstrably absorbed, then re-project what remains.
const applySnapshot = (agents: AgentSummary[], rev: number): void => {
    for (const [id, move] of pending) {
        if (rev >= move.untilRev) {
            pending.delete(id);
        }
    }
    latchRegistered(agents);
    const next = stabilizeRegistry(withPending(agents));
    if (sameEntries(registry.value, next)) {
        return;
    }
    registry.value = next;
};

// Record a local move and paint it immediately. `rev` is the revision the daemon reported for the mutation, so
// the intent survives exactly until a roster that includes it arrives, no timers, no fixed windows.
export const holdPending = (moves: readonly { id: string; present?: AgentSummary }[], rev: number): void => {
    for (const move of moves) {
        pending.set(move.id, move.present === undefined ? { untilRev: rev } : { untilRev: rev, present: move.present });
    }
    registry.value = withPending(registry.value.filter((agent) => !pending.has(agent.id)));
};

/* THE SAME REMOVAL, TAKEN BEFORE THE DAEMON HAS ANSWERED, and the way back if it never does.
 *
 * Archiving is the board's one safe exit: nothing is destroyed, the branch and the conversation are kept, and
 * the counter it lands in is one press from opening. What it is NOT is quick, behind the press sit a commit
 * of whatever the worktree held, a checkout teardown and a ref park, per repo. So the press held its card in
 * place for as long as the git took, which on a board carrying a thousand sessions reads as a button that did
 * nothing, and the honest response to a button that did nothing is to press it again.
 *
 * The card therefore leaves on the press and the request runs behind it. Everything that CANNOT be taken back
 * cheaply still waits for the answer, the chat tab stays open, the archive list is written from what actually
 * moved, the undo set counts what actually moved, so a refusal costs the user a card sliding back into its
 * lane under the error strip, and nothing else.
 *
 * Held at POSITIVE_INFINITY because at this moment there is no revision to hold to: no roster may retire this
 * intent, only the answer that replaces it (holdPending at the rev that applied it) or the rollback below.
 * Returns the rollback, which puts back every card it took but the ones named `keep`, the daemon's own
 * account of what moved, since an aimed-at agent it declined is a card that must come back. */
export const takeOffBoard = (ids: readonly string[]): ((keep?: ReadonlySet<string>) => void) => {
    const held = new Map(registry.value.filter((agent) => ids.includes(agent.id)).map((agent) => [agent.id, agent]));
    holdPending(
        ids.map((id) => ({ id })),
        Number.POSITIVE_INFINITY,
    );
    return (keep) => {
        const back = [...held].filter(([id]) => keep?.has(id) !== true);
        for (const [id] of back) {
            // Only ever this call's OWN unanswered intent: an overlapping press that has since re-held the same
            // id at a real revision is holding it against a roster in flight, and dropping that would let the
            // card it archived flicker back onto the board.
            if (pending.get(id)?.untilRev === Number.POSITIVE_INFINITY) {
                pending.delete(id);
            }
        }
        const returning = back.filter(([id]) => !pending.has(id)).map(([, agent]) => agent);
        if (returning.length > 0) {
            registry.value = withPending([...registry.value, ...returning]);
        }
    };
};

/* The review panel's diff query (the per-file landed flags behind "Land now", and the conflict report) is
 * pull-only, while this roster is push-fed, so a land this browser didn't perform itself (the auto-land at
 * turn completion, another device's manual land) used to flip the header badge to "Landed" while the panel
 * kept its pre-land answer: every file "not landed" under an armed Land now button, until a remount or a
 * window refocus happened to refetch. A status change is exactly "the daemon settled something about this
 * agent's work", so it is the diff's invalidation signal. An id this roster has never seen counts as a
 * change: the first snapshot of a (re)connection may be carrying the outcome of a turn that finished while
 * no stream was up. Unobserved queries are only marked stale, so a closed panel costs no request. */
const invalidateStaleWork = (agents: readonly AgentSummary[]): void => {
    const held = new Map(registry.value.map((agent) => [agent.id, agent.status]));
    for (const agent of agents) {
        if (held.get(agent.id) !== agent.status) {
            void queryClient.invalidateQueries({ queryKey: AGENT_DIFF.of(agent.id) });
            /* AND THE TRANSCRIPT WITH IT, on exactly the same signal and for the same reason one step further
             * along. The daemon writes a conversation's record as each turn SETTLES, so a status change is the
             * one moment that record can have grown, and the copy this browser warmed ahead of the click was
             * read before it did. Without this the board would hand a clicked card a transcript ending one turn
             * early, which is a worse answer than the round trip it saved. */
            invalidateAgentTranscript(agent.id);
        }
    }
};

// Roster snapshot from the events stream or an explicit read. Dropped when it predates what we already hold,
// an out-of-order answer is not news, it is a regression.
export const setAgents = (agents: AgentSummary[], rev: number): void => {
    if (rev < appliedRev) {
        return;
    }
    invalidateStaleWork(agents);
    /* WHAT LEFT THE ROSTER BY ANOTHER HAND THAN THIS BROWSER'S, the daemon's retention sweep, an archive or
     * discard on another device. Local moves are excluded: they already wrote both halves, and `pending` is
     * exactly the set of them still unconfirmed. A reset board has no ids to depart, so the reconnect's first
     * snapshot stays quiet.
     *
     * It is the one signal the pull-only archive list ever gets that it changed, so it is its invalidation,
     * without it the Finished header's count (and the door it gates) kept whatever the last visit read until
     * the next one. And it takes the departed agents' CHAT TABS with it, for the same reason archiving from
     * this board does (see useAgents-archive.ts): one agent is a card and a tab, and the sweep that keeps
     * the board clean was leaving the chat list to grow for the life of the sandbox. */
    const incoming = new Set(agents.map((agent) => agent.id));
    const departed = new Set(registry.value.filter((agent) => !incoming.has(agent.id) && !pending.has(agent.id)).map((agent) => agent.id));
    if (departed.size > 0) {
        void loadArchived();
        useChat().closeRetired(departed);
    }
    appliedRev = rev;
    applySnapshot(agents, rev);
    /* AND WHAT STARTED WORKING BY ANOTHER HAND THAN THIS BROWSER'S, the other half of the same reading. A
     * workflow's steps, an automation's wake, a turn sent from a phone: their tabs may already be open here,
     * opened before the turn existed and therefore showing nothing. This roster is the daemon saying the turn
     * is up, which is the moment those tabs can attach to it (useChat.attachStarted). */
    useChat().attachStarted(new Set(agents.filter((agent) => agent.status === `running`).map((agent) => agent.id)));
};

/* Drop everything that is a promise to a PARTICULAR daemon, keeping (or not) the painted roster.
 *
 * The revision always goes: the next daemon we speak to may be a restarted one whose counter began again at
 * 0, and holding onto a higher number would make us reject its every frame. Pending moves and undo offers are
 * promises about ids and revision lines that daemon may never have heard of, dropped with it. The undo offers,
 * and the fleet memo of cards derived from this roster, are dropped by the store-wide desync in useAgents.ts,
 * which calls this.
 *
 * The roster itself is the split. A sandbox SWITCH clears it (another sandbox's agents must never paint), but
 * a mere disconnect KEEPS it: the chat list blanking for the length of a reconnect turned every stall into a
 * visible outage, and the reconnect's immediate snapshot overwrites whatever staleness survived.
 *
 * Held wakes take the roster's side of that split, not the unconditional side, and for the roster's own reason:
 * they are PAINTED (the rail's Agents badge counts them, which is the only way an owner learns a wake is waiting
 * while they are elsewhere), so blanking them for the length of a reconnect would be the same visible outage. On
 * a switch they must go, they name run ids in a workspace the reader has left, and leaving them in made the
 * tile claim work waiting in the box they had just closed. */
export const desyncRegistry = (keepRoster: boolean): void => {
    if (!keepRoster) {
        registry.value = [];
        heldWakes.value = [];
    }
    pending.clear();
    registryStable.clear();
    appliedRev = -1;
    epoch += 1;
};

// Unread tracking: an agent whose updatedAt outruns the last time it was OPENED, while no turn of its own is
// in flight, "has
// something for you". The read marker itself lives on the daemon entry (AgentSummary.seenAt), not in this
// browser, read state is a fact about the work, so clearing site data, opening an incognito window, or
// switching to the phone must not resurrect a board full of "New" badges.
//
// Writes are optimistic: stamp the roster in place (the card repaints instantly, `registry` is a deep ref),
// then persist through the daemon, whose broadcast re-lands the same value on every other connected surface.
// Best-effort: a failed write only means the badge returns on the next roster frame, and a card with no
// registry entry is a draft, nothing to mark, nothing unread.
export const markSeen = (id: string): void => {
    const entry = registry.value.find((agent) => agent.id === id);
    if (entry === undefined) {
        return;
    }
    entry.seenAt = Date.now();
    void sandboxJson(`/agents/${encodeURIComponent(id)}/seen`, { method: `POST` }).catch(() => undefined);
};

// The escape hatch a notification surface owes the user: clear the whole board at once instead of clicking
// through every card to silence the rail badge.
export const markAllSeen = (): void => {
    const now = Date.now();
    for (const agent of registry.value) {
        agent.seenAt = now;
    }
    void sandboxJson(`/agents/seen`, { method: `POST` }).catch(() => undefined);
};

/* An open conversation adopts the roster's name for it.
 *
 * A tab seeds its title once, at open (openAgentConversation), and then owns it, which held while the only
 * thing that ever renamed a conversation was the user typing on this device. It no longer does: the daemon
 * promotes a title on its own when a plan names the job the opening prompt only hinted at, and a rename from
 * the phone has always had to reach the desktop. The registry is the authority, so a tab follows it.
 *
 * Following it UNCONDITIONALLY is what makes this safe rather than a race: the daemon refuses every promotion
 * that would overwrite a rename (see promoteTitle), so a title arriving here has already been judged better
 * than the one it replaces, and the browser needs no second opinion. Renames stay instant because rename()
 * writes the registry entry optimistically before it posts, this watch sees the new name on the tick the
 * user typed it, not a round trip later.
 *
 * The roster ARRAY is replaced on every frame it pushes, usage counters tick several times a second through a
 * running turn, so its identity says nothing about whether a title moved, and reconciling on it directly would
 * walk every open tab several times a second to write nothing. The filter below is what makes that cheap. */
const appliedTitles = new Map<string, string | undefined>();

/* Did any entry's title move since the last frame? A map lookup per entry and NO allocation in the steady
 * state, which is the whole point: this replaces a change key built by allocating a string per agent and
 * joining them on every roster frame, to catch a change that happens a handful of times per conversation.
 *
 * A SHRUNKEN roster is the one thing a per-entry sweep cannot see, so it is settled by the count, and the
 * rebuild that follows runs when an agent actually leaves the fleet, never on the usage frames that are almost
 * all of this traffic. A reset (the registry emptied) lands here too and leaves the memo correctly empty. */
const titlesMoved = (entries: readonly AgentSummary[]): boolean => {
    let moved = false;
    for (const agent of entries) {
        if (!appliedTitles.has(agent.id) || appliedTitles.get(agent.id) !== agent.title) {
            appliedTitles.set(agent.id, agent.title);
            moved = true;
        }
    }
    if (appliedTitles.size === entries.length) {
        return moved;
    }
    appliedTitles.clear();
    for (const agent of entries) {
        appliedTitles.set(agent.id, agent.title);
    }
    return true;
};

watch(registry, (entries) => {
    if (!titlesMoved(entries)) {
        return;
    }
    const { conversations } = useChat();
    for (const agent of entries) {
        const conversation = conversations.value.find((candidate) => candidate.conversationId === agent.id);
        // An entry with no title yet (a turn that has not begun) must not blank a tab that named itself.
        if (agent.title !== undefined && conversation !== undefined && conversation.title.value !== agent.title) {
            conversation.title.value = agent.title;
        }
    }
});

/* --- The beat's audit of this roster ---------------------------------------------------------------------
 * WHAT HAPPENS WHEN A SNAPSHOT NEVER LANDS. Everything above is written for frames that ARRIVE: out of order,
 * racing a read, racing this browser's own optimistic move. None of it can see the frame that was never
 * applied at all — dropped by the revision guard, delivered into a store instance nothing renders any more
 * (a dev hot update), lost with a consumer that stopped pulling. The roster is push-only, so the board simply
 * stops moving at that instant: the cards stay, the window keeps working, the chat keeps streaming, and only
 * a reload puts it right. That is the "the /agents view still says Question for you, I answered it minutes
 * ago" report, and until this there was nothing in the stream that could have told the browser.
 *
 * So the daemon's heartbeat carries the revision it was sent at (HeartbeatSchema), and this is what reads it.
 * A beat only goes out when that connection's queue is EMPTY, so by the time one arrives every frame the
 * daemon sent before it has already been applied here: a disagreement is not a race to be waited out, it is
 * proof that a snapshot went missing, and the answer is to read the roster once.
 *
 * A LOWER REVISION THAN WE HOLD IS THE SAME REPORT FROM THE OTHER SIDE, and the pull alone cannot fix it: the
 * guard would drop the pull's own answer as "older than what we have", which is exactly the freeze being
 * repaired. The daemon is the authority on its own revision line, so the line is adopted rather than defended.
 *
 * FREE WHEN NOTHING IS WRONG, which is what makes it affordable at all: the number rides a frame that was
 * already flying, an agreeing beat does nothing, and a busy fleet sends no beats because its queue is never
 * idle. One read in flight at a time, so a slow answer under load cannot stack a queue of them behind it. */
let auditing: Promise<void> | undefined;

export const auditRoster = (rev: number): void => {
    if (rev === appliedRev) {
        return;
    }
    /* SAID OUT LOUD, ONCE PER OCCURRENCE, because a repair nobody can see is how this took two hours of log
     * archaeology to narrow the first time: every window looked healthy, the daemon's own records showed the
     * frames going out, and the only account of it was a person saying the board had stopped moving. The line
     * lands in logs/client.jsonl with the two revisions on it (mcp diagnostics `errors --source browser`), so
     * the next occurrence is a dated, counted fact about WHICH window fell behind and by how much, and a repair
     * that starts happening every few seconds is visible as a repair rather than as silence. The reporter
     * dedupes per kind, so a persistent one cannot flood the log. */
    reportClient(`fleet.roster-behind`, `the roster missed a snapshot and was read back`, {
        level: `warn`,
        fields: { held: appliedRev, beat: rev },
    });
    if (rev < appliedRev) {
        appliedRev = -1;
    }
    auditing ??= refresh().finally(() => {
        auditing = undefined;
    });
};

/* Explicit registry pull, the reachable seam and pull-to-refresh use it; steady-state updates ride /events.
 *
 * Exported as `refreshAgents` for sandboxScope, which calls it on the seam where a switch lands. The roster
 * itself needs no such help, the new daemon's stream frames one on connect, but HELD WAKES do, for the
 * reason they are separate state at all: the stream knows nothing of holds, so this read is the only thing
 * that ever fills them. A switch drops them (desyncRegistry) and without this they would stay dropped until someone
 * opened the board, which is exactly the surface the rail's badge exists to save them from having to open. */
export const refreshAgents = async (): Promise<void> => refresh();

export const refresh = async (): Promise<void> => {
    const issuedAt = epoch;
    try {
        const body = await sandboxJson<{ agents: AgentSummary[]; rev: number; held?: AutomationApproval[] }>(`/agents`);
        // Answered on a revision line nobody is on any more, the daemon this read left for has since been
        // replaced (see `epoch`). Its number would land as a high-water mark the successor cannot beat.
        if (issuedAt !== epoch) {
            return;
        }
        // Through setAgents, not a raw assignment: this read races the stream, and a slow one that started
        // before the newest frame must not be allowed to undo it.
        setAgents(body.agents, body.rev);
        heldWakes.value = body.held ?? [];
    } catch {
        // Leave the last roster; the events stream repaints on reconnect.
    }
};

/* COMING BACK TO THE APP RE-READS THE BOARD.
 *
 * Steady state is pushed and needs nothing: the daemon frames a roster as agents start, park and finish. The
 * gap is at the EDGES of that, a laptop that slept, a phone whose tab was evicted from the foreground, a
 * stream that half-opened and died without a FIN. The connection heals itself, but only once the watchdog has
 * noticed the silence, and until then the board sits showing the moment the user walked away from. Someone
 * looking at it again is the one signal that the delay is now being WATCHED, so it is answered with a read
 * rather than waited out.
 *
 * Asked of this window (onScreen.ts), which every window of the app does for itself. Gated on the daemon being
 * reachable: with the stream down this would fail anyway, and the reconnect brings its own roster with it. One
 * request per return, not per second; a refresh that fails leaves the roster exactly where it stood.
 *
 * Module scope, like the unread watch (useAgents-fleet): this is a fact about the SESSION, not about whether the board
 * happens to be the open route, the rail's badge is drawn from the same roster on every page in the app. */
const { reachable } = useSandbox();
watch([onScreen, reachable] as const, ([looking, live], [wasLooking]) => {
    if (looking && !wasLooking && live) {
        void refresh();
    }
});

/* Release or drop a held wake, the automations routes' own verbs, so the board and any other surface cannot
 * come to mean different things by the same press. The entry leaves the list optimistically (the daemon
 * removes it before the detached turn runs); the trailing refresh() repaints whatever else moved. */
export const releaseHeld = async (id: string, verb: `approve` | `reject`): Promise<void> => {
    await sandboxJson(`/automations/pending/${encodeURIComponent(id)}/${verb}`, { method: `POST` });
    heldWakes.value = heldWakes.value.filter((entry) => entry.id !== id);
    void refresh();
};

/* --- The archived half ---------------------------------------------------------------------------------------
 * Archived agents are absent from the roster the /events stream carries, which is the point: the board's live
 * state stays the size of the work in flight. The list is PULL-ONLY instead, read where something can have
 * changed it: at the board's mount, when the archive is opened, when the active daemon (re)appears
 * (sandboxScope's reachable watch, a daemon that just booted may have filed agents away itself), and when an
 * id leaves the roster by another hand than this browser's (see setAgents).
 *
 * The two refs the list lives in are declared far above, next to the roster, because `fleet` reads them. What
 * archiving is, and what it takes with it, opens useAgents-archive.ts. */

// A sandbox SWITCH is the one thing the archive list must not survive: another daemon's archive on this board
// would offer restores of agents this one has never heard of. Deliberately NOT folded into resetAgents, that
// also runs on every stream failure, and blanking the count (and the archive door it gates) on a network blip
// is a disappearing button; the last list is better company for a reconnect than an empty one, and the
// reachable seam re-reads it the moment the daemon answers again.
export const resetArchive = (): void => {
    archived.value = [];
};

/* CONCURRENT CALLERS ARE THE NORMAL CASE, so they share one request. The reachable seam asks for this list, and
 * so does every mounted chat pane's own reachable watch, a three-pane split therefore asked four times in the
 * same flush, and each answer replaced the array and repainted every reader of it. They all want the same list
 * at the same instant, which is exactly what one shared promise is.
 *
 * Only for the length of the flight: a caller arriving after it settles is asking a new question (the daemon
 * archives on its own, a boot sweep, a retention pass), and gets its own request. */
let archiveInFlight: Promise<void> | undefined;

export const loadArchived = async (): Promise<void> => {
    archiveInFlight ??= (async () => {
        archiveLoading.value = true;
        try {
            const body = await sandboxJson<{ agents: AgentSummary[] }>(`/agents/archived`);
            // Widened to FleetAgent here rather than at render: an archived agent has nothing unread by
            // construction (it left the board), and the archive list's own rows are drawn for agents that are
            // not open, the one archived agent that IS open, because the user is writing in it, is rebuilt by
            // `fleet` with those two fields answered live. Object.assign, not a spread, this array is this
            // call's own freshly-parsed JSON.
            archived.value = body.agents.map((agent) => Object.assign(agent, { open: false, unread: false, unsent: false }));
        } catch {
            // Leave whatever was listed last; the view reports its own emptiness.
        } finally {
            archiveLoading.value = false;
            archiveInFlight = undefined;
        }
    })();
    await archiveInFlight;
};

/* ONE ROSTER PER WINDOW, told to the dev server's hot updater (hotReload.ts), and the same argument the chat's
 * singletons make one directory over. A hot update re-executes this module as a NEW instance while the stream
 * that feeds it keeps the binding it captured to the old one: the board then renders a store nothing writes to,
 * frozen at whatever the board's own mount read painted on the way past, in a window that is otherwise
 * perfectly alive — the chat streams, the tree refreshes, the popped-out window's every note still lands. Only
 * a reload has ever cleared it.
 *
 * The beat's audit above repairs a roster that MISSED a frame; it cannot repair one whose feed is talking to a
 * different object, because the beat is delivered to that object too. Reloading is the only update a store like
 * this can honestly apply. */
reloadOnHotUpdate(import.meta);
