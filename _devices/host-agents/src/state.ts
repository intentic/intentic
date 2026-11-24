import { refuse } from "@intentic/contract-serve";
import { errorMessage } from "@intentic/base/errors";
import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import type { SystemEvent } from "@intentic/sandbox-contract/events/system-events";
import type { SandboxHandlerInput } from "@intentic/sandbox-contract/protocol/procedure-types";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { cardOf, type LiveTurn, type WaitingMessage } from "./cards.js";
import { createHarnessConnections, type HarnessConnections } from "./connection.js";
import { harnessState } from "./engines.js";
import { type HarnessFacts, readHarnessFacts } from "./harness-facts.js";
import { HARNESSES, type HarnessSpec } from "./harnesses.js";
import { type Place, type PlaceHost, placeHosts } from "./place.js";
import type { Run } from "./run.js";
import { createSignIns, type SignIns } from "./sign-in.js";
import { type ConversationStore, conversationStore, type StoredConversation } from "./store.js";

// WHAT ONE PROCESS KNOWS OF THE AGENTS ON THIS COMPUTER: every conversation's record, the turns running now, who
// listens for the roster, and what each harness last said of itself. One of these stands behind every window of the
// desktop app; the procedures (procedures/) and the turns (turns.ts) are its readers and writers.

// The folder a window shows, as its grant names it, and the side of this computer it is on.
export interface HostFolder {
    readonly root: string;
    readonly place: Place;
}

export interface HostAgentsOptions {
    // Where conversations are kept (`~/.intentic/host-agents`).
    readonly home: string;
    readonly log: (line: string) => void;
    // Whether the reader has turned agents on for this computer. Until then no turn starts and nothing is fetched or
    // signed in: reading what is already there is all a window may do.
    readonly accepted: () => boolean;
    readonly now?: (() => number) | undefined;
    readonly harnesses?: readonly HarnessSpec[] | undefined;
    readonly hostFor?: ((place: Place) => PlaceHost) | undefined;
}

export type RunAsk = SandboxHandlerInput<`agent`, `run`>;

// One message on its way to a turn: its words, the files that go with them, and the request it came in.
export interface Queued {
    readonly prompt: string;
    readonly attachments: readonly string[];
    readonly ask: RunAsk;
}

// One held behind a running turn, as its card lists it meanwhile.
export type Waiting = Queued & WaitingMessage;

// A turn running now.
export interface Live extends LiveTurn {
    readonly stop: AbortController;
    // The cards it is parked on, by request id.
    readonly cards: Map<string, `permission` | `question`>;
    // Messages sent while it runs: the next turn's words.
    readonly queue: Waiting[];
    queueRevision: number;
    waiting: { permission: boolean; question: boolean };
    stopping: boolean;
    // What its last error frame said, for the card of a turn that failed.
    failure: string | undefined;
}

export const NOT_ACCEPTED = `Agents on this computer are off. Turn them on from this window's Agents page first.`;
const NO_CONVERSATION = `No such conversation in this folder.`;

export class HostState {
    readonly now: () => number;
    readonly log: (line: string) => void;
    readonly accepted: () => boolean;
    readonly harnesses: readonly HarnessSpec[];
    readonly hostFor: (place: Place) => PlaceHost;
    readonly store: ConversationStore;
    readonly connections: HarnessConnections;
    readonly signIns: SignIns;
    readonly startedAt: number;
    readonly records = new Map<string, StoredConversation>();
    readonly live = new Map<string, Live>();
    // The last finished run of each conversation, for a window that attaches just after it ended.
    readonly finished = new Map<string, Run>();
    // The commands each harness last published, for a composer that has run nothing yet.
    readonly commands = new Map<string, readonly AgentCommand[]>();
    // Each conversation's next run, awaited by an attach that named the one before it.
    readonly nextRun = new Map<string, Set<() => void>>();
    // Every record read off disk: what each procedure waits on before it answers.
    readonly loaded: Promise<void>;
    rev = 1;
    private readonly listeners = new Map<string, Set<(event: SystemEvent) => void>>();
    private readonly runningListeners = new Set<(running: number) => void>();
    private readonly facts = new Map<string, Promise<HarnessFacts>>();
    // The harnesses whose last turn was refused for want of a sign-in, by key. A harness can state an account and still
    // refuse to work on it (a stored login past its time limit, which only signing in again renews), so its own word
    // on being signed in is not taken while this stands.
    private readonly signInsNeeded = new Set<string>();
    // The conversations kept since this process started: written once more, at once, as it goes (`interruptAll`), since
    // a write still on its way then would be lost with it.
    private readonly kept = new Set<string>();

    constructor(options: HostAgentsOptions) {
        this.now = options.now ?? Date.now;
        this.log = options.log;
        this.accepted = options.accepted;
        this.harnesses = options.harnesses ?? HARNESSES;
        this.hostFor = options.hostFor ?? placeHosts();
        this.store = conversationStore(options.home, options.log);
        this.connections = createHarnessConnections(options.log);
        this.signIns = createSignIns(this.now);
        this.startedAt = this.now();
        this.loaded = this.store.load().then(
            (all) => {
                for (const record of all) {
                    this.records.set(record.id, record);
                }
            },
            (error: Error) => this.log(`could not read conversations: ${errorMessage(error)}`),
        );
    }

    harnessNamed(id: string): HarnessSpec | undefined {
        return this.harnesses.find((harness) => harness.id === id);
    }

    // The folder as the harness's own place names it.
    cwdOf(folder: HostFolder): string {
        return folder.place.kind === `wsl` ? folder.place.path : folder.root;
    }

    // One harness in one place: what its process and its facts are kept under.
    keyOf(host: PlaceHost, harness: HarnessSpec): string {
        return `${host.key}/${harness.id}`;
    }

    cardsOf(root: string, archived: boolean): AgentSummary[] {
        return [...this.records.values()]
            .filter((record) => record.folder === root && (record.archivedAt !== undefined) === archived)
            .toSorted((a, b) => b.updatedAt - a.updatedAt)
            .map((record) => cardOf(record, this.live.get(record.id)));
    }

    card(record: StoredConversation): AgentSummary {
        return cardOf(record, this.live.get(record.id));
    }

    // The roster of one folder, whole, to every window on it. Newest `rev` wins at the reader.
    broadcast(root: string): void {
        this.rev += 1;
        const frame: SystemEvent = { kind: `agents`, agents: this.cardsOf(root, false), rev: this.rev };
        for (const listener of this.listeners.get(root) ?? []) {
            listener(frame);
        }
    }

    subscribe(root: string, listener: (event: SystemEvent) => void): () => void {
        const set = this.listeners.get(root) ?? new Set();
        this.listeners.set(root, set);
        set.add(listener);
        return () => {
            set.delete(listener);
        };
    }

    onRunningChanged(listener: (running: number) => void): () => void {
        this.runningListeners.add(listener);
        return () => {
            this.runningListeners.delete(listener);
        };
    }

    tellRunning(): void {
        for (const listener of this.runningListeners) {
            listener(this.live.size);
        }
    }

    // Kept in memory at once and written behind (the store lets only the newest write land): a write that fails is
    // said, and the next change writes again.
    keep(record: StoredConversation): void {
        this.records.set(record.id, record);
        this.kept.add(record.id);
        void this.store.save(record).catch((error: Error) => this.log(`could not save conversation ${record.id}: ${errorMessage(error)}`));
    }

    // The process is going: every running turn is cut where it stands, and what it had drawn is written before this
    // returns, so the conversation opens again on what the reader saw. Its harness is ended by the caller.
    interruptAll(): void {
        for (const [id, turn] of this.live) {
            turn.stop.abort();
            turn.run.finish(`stopped`);
            const held = this.records.get(id);
            if (held === undefined) {
                continue;
            }
            this.records.set(id, { ...held, rows: [...held.rows, ...structuredClone(turn.run.rows())], status: `interrupted`, turns: held.turns + 1, updatedAt: this.now() });
            this.kept.add(id);
        }
        this.live.clear();
        for (const id of this.kept) {
            const record = this.records.get(id);
            if (record === undefined) {
                continue;
            }
            try {
                this.store.saveNow(record);
            } catch (error) {
                this.log(`could not save conversation ${id} on the way out: ${errorMessage(error)}`);
            }
        }
        this.kept.clear();
    }

    amend(record: StoredConversation, patch: Partial<StoredConversation>): StoredConversation {
        const next = { ...record, ...patch };
        this.keep(next);
        this.broadcast(record.folder);
        return next;
    }

    // The turn running in one of this folder's conversations; a conversation of another folder is, to this window, not
    // running at all.
    liveIn(folder: HostFolder, id: string): Live | undefined {
        return this.records.get(id)?.folder === folder.root ? this.live.get(id) : undefined;
    }

    // A window reads only its own folder's conversations: one of another folder is, to it, not there.
    recordIn(folder: HostFolder, id: string): StoredConversation {
        const record = this.records.get(id);
        return record === undefined || record.folder !== folder.root ? refuse(NO_CONVERSATION, 404) : record;
    }

    forgetFacts(key: string): void {
        this.facts.delete(key);
    }

    // A turn on this harness was refused for want of a sign-in, or ran: what `signInNeeded` answers from here on.
    noteSignIn(key: string, needed: boolean): void {
        if (needed) {
            this.signInsNeeded.add(key);
        } else {
            this.signInsNeeded.delete(key);
        }
    }

    signInNeeded(key: string): boolean {
        return this.signInsNeeded.has(key);
    }

    // What a harness says of itself in one place, asked once and kept until a sign-in or a refusal changes it. Nothing
    // for a harness that is not set up there, which is looked for again each time rather than remembered as absent, and
    // said by nobody: most of the harnesses a window asks about are not on any one computer.
    async factsFor(folder: HostFolder, harness: HarnessSpec): Promise<HarnessFacts | undefined> {
        // Reading a harness starts it. Until the reader has turned agents on, nothing of theirs is started: a window
        // learns only which harnesses are here, which is a look at the disk.
        if (!this.accepted()) {
            return undefined;
        }
        const host = this.hostFor(folder.place);
        const key = this.keyOf(host, harness);
        const known = this.facts.get(key);
        if (known !== undefined) {
            // allow(silent-catch): the reading's own failure was said when it failed, below; here it only means "not known"
            return known.catch(() => undefined);
        }
        const standing = await harnessState(host, harness);
        if (standing.state !== `ready`) {
            return undefined;
        }
        // Another asker may have started the reading while this one looked for the harness.
        const reading = this.facts.get(key) ?? this.connections.acquire(key, host, standing.launch, this.cwdOf(folder)).then((connection) => readHarnessFacts(connection, this.cwdOf(folder)));
        this.facts.set(key, reading);
        return reading.catch((error: Error) => {
            if (this.facts.get(key) === reading) {
                this.facts.delete(key);
            }
            this.log(`could not read ${harness.label}: ${errorMessage(error)}`);
            return undefined;
        });
    }
}
