import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESTART_LOSSES, RESUME_NOTES, withoutResumeNote } from "@intentic/sandbox-contract/events/resume";
import { MEMORY_KILL_RERUNS, type TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import { unstubbed } from "@intentic/testing";
import { pino } from "pino";
import { childActor } from "../../../../auth/principal.js";
import type { Services } from "../../../../composition.js";
import { beginTurn } from "../../../../conversations/actor/conversation-actors.testing.js";
import type { ConversationActors } from "../../../../conversations/actor/conversation-actors.js";
import type { HeldRecord } from "../../../../conversations/actor/conversation-state.js";
import { restoredLimitHold, storedLimitHold } from "../../../../conversations/actor/limit-hold.js";
import { fleetStoreOver, memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { sqliteAgentsStore } from "../../../../conversations/registry/agents-store.js";
import { conversationEntry } from "../../../../conversations/registry/agents-store.testing.js";
import { readMemoryRestart } from "../../../../bootstrap/restart/memory-restart-read.js";
import { logsRoot } from "../../../../seams/logs-root.js";
import type { TurnInput } from "../../../../seams/turn-starter.js";
import { fileTranscriptRecord } from "../../../../sessions/transcript-record.js";
import type { TranscriptAgent } from "../../../../sessions/agent-transcript.js";
import { fileSandboxSettingsStore } from "../../../../settings/settings-store.js";
import { conversationsDbPath, openConversationsDb } from "../../../../store/conversations-db.js";
import { opt } from "../../../../opt.js";
import type { BudgetSnapshot } from "../../../../workload/resource-budget.js";
import { type JournalledTurn, sqliteTurnJournal, type TurnJournal } from "../../../../store/journals/turn-journal.js";
import { MEMORY_KILLS_FILE, type MemoryKill, type PostMortem } from "../../../../system/resources/memory-records.js";
import { classifyFailure, type ErrorFrame, type FailureContext, type FailureQueries } from "../../frames/classify-failure.js";
import { recordQueries } from "../../frames/failure-queries.js";
import { GOES_WHEN_ROOM, KILLED_AGAIN, killSentence, WAITS_FOR_PRESS, waitsForRoom } from "../holds/memory-kill.js";
import type { HeldTurn } from "../holds/held-turn.js";
import { ROOM_SETTLE_MS } from "../holds/room-holds.js";
import { resumeInterruptedTurns } from "../recovery/cut-turns.testing.js";
import { memoryCaused, memoryRestartOf, restartResume } from "../recovery/restart-resume-policy.js";
import { createTurnResumeScheduler } from "../turn-resume.js";

/* WHAT A MEMORY KILL BRINGS BACK, AND WHAT IT HOLDS (holds/memory-kill.ts). On 2026-11-05 a background job of
   sub-tidy-pebble-aii1 (a subagent of noble-forge-r92c) grew without limit, the VM thrashed, netd killed the frozen
   daemon, and after the restart five turns sat "interrupted … autoResumeOnRestart is off" in Attention. Switching that
   on would have re-run the cause too, all at once, into a machine still recovering. These suites play that night and its
   smaller cousin, a runtime killed under a daemon that stays up: the victims come back by themselves, one at a time and
   only once memory has stayed free, told what happened; the conversation whose own process grew is held for a press with
   what the sandbox found; and a request memory kills every time it runs stops coming back after its second re-run. */

const PROFILE = { agent: "claude", harness: "native" } as const;
const silent = pino({ level: "silent" });

// When memory last became free, as the budget reads it (resource-budget.ts roomSince); undefined while it is short.
interface Room {
    since: number | undefined;
}

// A conversation's actors and registry over one database in a fresh directory, with every record a pass writes real:
// the journal, the transcript record, the settings. `parents` names who spawned whom; a turn the pass starts is begun on
// the actor (so the conversation reads busy) and kept for the suite to read.
const fleetOn = async (ids: readonly string[], parents: ReadonlyMap<string, string> = new Map()) => {
    const root = mkdtempSync(join(tmpdir(), "memory-kill-"));
    const db = openConversationsDb(conversationsDbPath(root));
    // The rows a daemon that died under these turns left: a subagent knows the parent that started it.
    sqliteAgentsStore(db).save(
        ids.map((id) => {
            const parent = parents.get(id);
            return conversationEntry({ id, identity: parent === undefined ? {} : { startedBy: childActor(parent) } });
        }),
    );
    const { agents, conversations } = memoryFleet(fleetStoreOver(db));
    await agents.init();
    const journal: TurnJournal = sqliteTurnJournal(db);
    const record = fileTranscriptRecord(root);
    const started: (TurnInput & { conversationId: string })[] = [];
    const room: Room = { since: undefined };
    const ledger: unknown[] = [];
    const services = unstubbed<Services>("services", {
        agents,
        conversations,
        turnJournal: journal,
        logger: silent,
        config: unstubbed<Services["config"]>("config", { historyRoot: root }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        sandboxSettings: fileSandboxSettingsStore(join(root, "settings.json")),
        sessions: unstubbed<Services["sessions"]>("sessions", { readTail: async () => [] }),
        usage: unstubbed<Services["usage"]>("usage", { turns: async () => [], record: async (row) => void ledger.push(row) }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            append: (agent: TranscriptAgent, rows) => record.append(agent.id, rows),
            count: (agent: TranscriptAgent) => record.count(agent.id),
            page: (agent: TranscriptAgent, window = {}) => record.window(agent.id, window),
        }),
        resources: unstubbed<Services["resources"]>("resources", {
            roomSince: async () => room.since,
            // The budget's own witness of a killed runtime: no reading short, the OOM counter never moved.
            shortRecently: async () => false,
            snapshot: async () => unstubbed<BudgetSnapshot>("snapshot", { reading: unstubbed<BudgetSnapshot["reading"]>("reading", { oomKills: 0 }) }),
        }),
        turns: unstubbed<Services["turns"]>("turns", {
            drain: async () => {},
            start: async (turn) => {
                started.push(turn);
                const begun = await beginTurn(conversations, { conversationId: turn.conversationId, isolated: true, prompt: turn.prompt, profile: PROFILE }, Date.now());
                return begun === "begun" ? { id: `run-${String(started.length)}`, async *frames() {} } : begun;
            },
        }),
    });
    const setPolicy = async (memoryKillPolicy: "wait" | "resume"): Promise<void> => {
        await services.sandboxSettings.set({ ...(await services.sandboxSettings.get()), memoryKillPolicy });
    };
    return { root, services, agents, conversations, journal, started, room, ledger, record, setPolicy };
};

const held = (conversations: Pick<ConversationActors, "state">, id: string): HeldTurn | undefined => conversations.state(id)?.resume.held;

/* THE NIGHT OF 2026-11-05: the restart memory caused. */

const BRAVE = "brave-quill-q6g5";
const SAGE = "lively-sage-m3k8";
const AMBER = "sub-amber-reef-p2x7";
const FORGE = "noble-forge-r92c";
const PEBBLE = "sub-tidy-pebble-aii1";
const VICTIMS = [BRAVE, SAGE, AMBER, FORGE] as const;
const NIGHT = [...VICTIMS, PEBBLE] as const;
// sub-tidy-pebble is noble-forge's subagent; sub-amber-reef is brave-quill's, a victim like its parent.
const PARENTS: ReadonlyMap<string, string> = new Map([
    [PEBBLE, FORGE],
    [AMBER, BRAVE],
]);

const KILLED_AT = Date.parse("2026-11-05T04:21:57Z");
const BOOT_AT = Date.parse("2026-11-05T04:22:18Z");
const SUMMARY =
    "The sandbox ran out of memory: integra (pid 1077125), started by sub-tidy-pebble-aii1 in background job job-integra, grew to 17.6 GB resident and 33.0 GB swapped, and the kernel killed it.";

// The boot's post-mortem as the worker drawing it (system/boot/restarts/post-mortem.ts) would conclude it: one process,
// sub-tidy-pebble's, killed for memory, and netd's kill of the frozen daemon before it.
const postMortem = (over: Partial<PostMortem> = {}): PostMortem => ({
    cause: "memory",
    killed: [
        { at: KILLED_AT, killer: "kernel-oom", pid: 1_077_125, comm: "integra", rssBytes: 17.6e9, swapBytes: 33e9, owner: PEBBLE, jobId: "job-integra" },
    ],
    netd: [{ at: Date.parse("2026-11-05T02:39:18Z"), kind: "stuck", pid: 65, silentMs: 300_000, psi: { someAvg10: 47.3, fullAvg10: 31 } }],
    culprits: [PEBBLE],
    summary: SUMMARY,
    ...over,
});

// Each cut turn as the journal held it when the daemon died, each on the session its provider had minted.
const cut = (conversationId: string): JournalledTurn => ({
    kind: "turn",
    turn: { prompt: `carry on ${conversationId}`, messageId: `m-${conversationId}`, conversationId, isolated: true, ...PROFILE },
    sessionId: `s-${conversationId}`,
    startedAt: BOOT_AT - 2 * 60 * 60_000,
    attempts: 0,
});

// The boot after the night: the post-mortem read through the boot's own reader, stubbed, and the cut turns recovered
// under the answer it gives, with autoResumeOnRestart off as it was.
const bootAfter = async (found: PostMortem | undefined, policy?: "wait" | "resume") => {
    const fleet = await fleetOn(NIGHT, PARENTS);
    if (policy !== undefined) {
        await fleet.setPolicy(policy);
    }
    for (const id of NIGHT) {
        await fleet.journal.recordTurn(cut(id));
    }
    const read: string[] = [];
    const memory = await readMemoryRestart(
        { logger: silent, services: fleet.services },
        {
            readPostMortem: async (historyRoot) => {
                read.push(historyRoot);
                return found;
            },
        },
    );
    const resume = restartResume({ ownerAsked: false, storm: false, autoResumeOnRestart: false, memory });
    await resumeInterruptedTurns(fleet.services, BOOT_AT, resume);
    expect(read).toEqual([fleet.root]);
    return { ...fleet, resume };
};

// One resume pass at `at`, and the conversations it started.
const passAt = async (fleet: Awaited<ReturnType<typeof fleetOn>>, at: number): Promise<string[]> => {
    const before = fleet.started.length;
    await createTurnResumeScheduler(fleet.services).tick(at);
    return fleet.started.slice(before).map((turn) => turn.conversationId);
};

describe("the restart of 2026-11-05, which memory caused", () => {
    test("holds every cut turn at boot instead of running any, the culprit for a press with what the post-mortem found", async () => {
        const fleet = await bootAfter(postMortem());
        expect(fleet.started).toEqual([]);
        expect(await fleet.journal.list()).toEqual([]);
        for (const id of VICTIMS) {
            expect(held(fleet.conversations, id)).toMatchObject({ reason: "stopped", sessionId: `s-${id}`, ran: true, memoryKill: { reruns: 0, found: SUMMARY, restart: true } });
            expect(held(fleet.conversations, id)?.pressOnly).toBeUndefined();
            // Read as a turn on its way back, not as one waiting for a press.
            expect(fleet.conversations.state(id)?.turn.resuming).toBe(true);
        }
        expect(held(fleet.conversations, FORGE)?.memoryKill?.culpritChild).toBe(PEBBLE);
        expect(held(fleet.conversations, BRAVE)?.memoryKill?.culpritChild).toBeUndefined();
        expect(held(fleet.conversations, PEBBLE)).toMatchObject({ reason: "stopped", pressOnly: true, memoryKill: { found: SUMMARY, restart: true } });
        // The culprit's card says what was found and why nothing sends it again.
        expect(fleet.conversations.state(PEBBLE)?.turn.resuming).toBe(false);
        const pebble = fleet.agents.entry(PEBBLE)?.ending;
        expect(pebble).toMatchObject({ kind: "failed" });
        expect(pebble?.kind === "failed" ? pebble.failure : "").toContain("integra (pid 1077125)");
        expect(pebble?.kind === "failed" ? pebble.failure : "").toContain("not sent again by itself");
        // Each cut turn's words stay on the record, the culprit's closed by the restart's notice; a victim's re-run brings its own.
        expect((await fleet.record.read(PEBBLE)).at(-1)).toMatchObject({ role: "notice", noticeCode: { code: "restartInterrupted" } });
        expect((await fleet.record.read(BRAVE)).map((row) => row.role)).toEqual(["user"]);
    });

    test("lets brave-quill, lively-sage, sub-amber-reef and noble-forge back one at a time once memory settles, and never sub-tidy-pebble", async () => {
        const fleet = await bootAfter(postMortem());
        // Memory still short: nothing goes.
        expect(await passAt(fleet, BOOT_AT + 1_000)).toEqual([]);
        // Free, but not yet for long enough.
        fleet.room.since = BOOT_AT + 1_000;
        expect(await passAt(fleet, BOOT_AT + 2_000)).toEqual([]);
        // Each settled pass lets exactly one go; the room it takes is short again until memory has stayed free once more.
        const order: string[] = [];
        let at = BOOT_AT + 1_000 + ROOM_SETTLE_MS;
        for (let pass = 0; pass < VICTIMS.length; pass += 1) {
            const went = await passAt(fleet, at);
            expect(went).toHaveLength(1);
            order.push(...went);
            fleet.room.since = at + 500;
            expect(await passAt(fleet, at + 1_000)).toEqual([]);
            at += 500 + ROOM_SETTLE_MS;
        }
        expect([...order].sort()).toEqual([...VICTIMS].sort());
        // However long memory then stays free, the culprit waits for a press.
        expect(await passAt(fleet, at + 60 * 60_000)).toEqual([]);
        expect(held(fleet.conversations, PEBBLE)).toMatchObject({ pressOnly: true, fired: false });

        // Every re-run is told it was killed for memory, what was found, and what a restart costs, on its own session.
        for (const turn of fleet.started) {
            expect(turn.resume).toBe("memory");
            expect(turn.sessionId).toBe(`s-${turn.conversationId}`);
            expect(turn.prompt.startsWith(RESUME_NOTES.memory)).toBe(true);
            expect(turn.prompt).toContain(`What the sandbox found: ${SUMMARY}`);
            expect(turn.prompt).toContain(RESTART_LOSSES);
            expect(withoutResumeNote(turn.prompt)).toBe(`carry on ${turn.conversationId}`);
        }
        // noble-forge alone hears that its subagent was the cause, so it does not hand it the same work again.
        const forge = fleet.started.find((turn) => turn.conversationId === FORGE);
        expect(forge?.prompt).toContain(`Your subagent ${PEBBLE} was the cause`);
        expect(fleet.started.filter((turn) => turn.prompt.includes("Your subagent")).map((turn) => turn.conversationId)).toEqual([FORGE]);
    });

    // The post-mortem may name the parent too (its stamp rides the child's process environment): a parent that only
    // supervises the culprit, with no process of its own killed, is a victim, not a cause.
    test("lets a parent the post-mortem also names go as a victim, where only its subagent's process was killed", async () => {
        const fleet = await bootAfter(postMortem({ culprits: [PEBBLE, FORGE] }));
        expect(held(fleet.conversations, FORGE)).toMatchObject({ memoryKill: { culpritChild: PEBBLE } });
        expect(held(fleet.conversations, FORGE)?.pressOnly).toBeUndefined();
        expect(held(fleet.conversations, PEBBLE)?.pressOnly).toBe(true);
    });

    test("holds every victim for a press where the answer to a memory kill is to wait, saying what was found", async () => {
        const fleet = await bootAfter(postMortem(), "wait");
        fleet.room.since = BOOT_AT - 60 * 60_000;
        expect(await passAt(fleet, BOOT_AT + ROOM_SETTLE_MS)).toEqual([]);
        for (const id of NIGHT) {
            expect(held(fleet.conversations, id)).toMatchObject({ memoryKill: { found: SUMMARY } });
            expect(fleet.conversations.state(id)?.turn.resuming).toBe(false);
            const ending = fleet.agents.entry(id)?.ending;
            expect(ending?.kind === "failed" ? ending.failure : "").toContain(SUMMARY.slice(0, 40));
            // No frame was written for a turn the restart cut, so the card's press is where the chat reads that memory
            // killed it, and asks the memory kill's question rather than the stop's.
            expect(fleet.agents.get(id)?.press).toMatchObject({ kind: "continue", ending: { reason: "stopped", held: { memoryKill: true } } });
        }
    });

    // Any other restart behaves exactly as before: autoResumeOnRestart is off, so each cut turn stands interrupted.
    test("leaves a restart memory did not cause to autoResumeOnRestart, as it always was", async () => {
        const fleet = await bootAfter(postMortem({ cause: "unknown", killed: [], culprits: [], summary: "The sandbox stopped for a reason nothing recorded." }));
        expect(fleet.resume).toEqual({ resume: false, why: "off" });
        for (const id of NIGHT) {
            expect(held(fleet.conversations, id)).toBeUndefined();
            expect((await fleet.record.read(id)).at(-1)).toMatchObject({ role: "notice", noticeCode: { code: "restartInterrupted" } });
        }
        fleet.room.since = BOOT_AT - 60 * 60_000;
        expect(await passAt(fleet, BOOT_AT + ROOM_SETTLE_MS)).toEqual([]);
    });

    test("leaves a clean stop, which has no post-mortem, to autoResumeOnRestart too", async () => {
        const fleet = await bootAfter(undefined);
        expect(fleet.resume).toEqual({ resume: false, why: "off" });
        expect(NIGHT.map((id) => held(fleet.conversations, id))).toEqual(NIGHT.map(() => undefined));
    });
});

// A hold the release has not sent yet is the entry's own (limit-hold.ts), so a second restart before memory settles puts
// it back for the release, with its re-runs and what was found, rather than on the stop ladder or nowhere.
test("a memory kill's hold survives another restart, still waiting for room", () => {
    const record: HeldRecord = {
        input: cut(FORGE).turn,
        reason: "stopped",
        sessionId: `s-${FORGE}`,
        ran: true,
        memoryKill: { reruns: 1, found: SUMMARY, restart: true, culpritChild: PEBBLE },
        recordedAt: BOOT_AT,
        fired: false,
        tries: 0,
    };
    const stored = storedLimitHold(record);
    expect(stored).toMatchObject({ reason: "stopped", memoryKill: { reruns: 1, found: SUMMARY, restart: true, culpritChild: PEBBLE } });
    // The entry still reads as the turn the restart interrupted: the release has not sent it yet.
    const restored = restoredLimitHold(conversationEntry({ id: FORGE, ending: { kind: "interrupted" }, ...opt("limitHold", stored) }));
    expect(restored).toMatchObject({ reason: "stopped", memoryKill: record.memoryKill, fired: false, tries: 0 });
    expect(restored === undefined ? false : waitsForRoom(restored)).toBe(true);
    // A culprit's stays a press's.
    const culprit = storedLimitHold({ ...record, input: cut(PEBBLE).turn, pressOnly: true });
    const back = restoredLimitHold(conversationEntry({ id: PEBBLE, ending: { kind: "failed", failure: SUMMARY }, ...opt("limitHold", culprit) }));
    expect(back).toMatchObject({ pressOnly: true, memoryKill: { found: SUMMARY } });
    expect(back === undefined ? true : waitsForRoom(back)).toBe(false);
});

describe("what decides a restart was memory's", () => {
    const memory = memoryRestartOf(postMortem(), (id) => PARENTS.get(id));

    test("a restart storm still resumes nothing and holds nothing, memory's or not", () => {
        expect(restartResume({ ownerAsked: true, storm: true, autoResumeOnRestart: true, memory })).toEqual({ resume: false, why: "storm" });
    });

    test("memory, the daemon the OOM killer's own victim, or netd ending a loop memory starved; not a loop merely stuck", () => {
        expect(memoryCaused(postMortem())).toBe(true);
        expect(memoryCaused(postMortem({ cause: "oom-victim", killed: [] }))).toBe(true);
        const stuck: Partial<PostMortem> = { cause: "netd-stuck", killed: [], culprits: [] };
        expect(memoryCaused(postMortem({ ...stuck, netd: [{ at: KILLED_AT, kind: "stuck", psi: { someAvg10: 47.3, fullAvg10: 31 } }] }))).toBe(true);
        expect(memoryCaused(postMortem({ ...stuck, netd: [{ at: KILLED_AT, kind: "restart-held" }] }))).toBe(true);
        expect(memoryCaused(postMortem({ ...stuck, netd: [{ at: KILLED_AT, kind: "stuck", psi: { someAvg10: 2, fullAvg10: 0 } }] }))).toBe(false);
        expect(memoryCaused(postMortem({ cause: "unknown", killed: [] }))).toBe(false);
    });

    test("names the conversation whose own process was killed as the culprit, and only that one", () => {
        expect(memory).toEqual({ summary: SUMMARY, culprits: new Set([PEBBLE]) });
        expect(memoryRestartOf(postMortem({ culprits: [PEBBLE, FORGE] }), (id) => PARENTS.get(id))?.culprits).toEqual(new Set([PEBBLE]));
        expect(memoryRestartOf(undefined, () => undefined)).toBeUndefined();
    });
});

/* A RUNTIME MEMORY KILLED UNDER A DAEMON THAT STAYED UP (frames/memory-death.ts). */

const NOW = 1_800_000_000_000;
const KILLED: ErrorFrame = { kind: "error", message: "claude exited with code 137" };
const standing = { state: "no-code", paths: [], check: undefined } as const;

// netd's line for a process it killed, written where it writes them (memory-records.ts MEMORY_KILLS_FILE).
const recordKills = (root: string, kills: readonly MemoryKill[]): void => {
    mkdirSync(logsRoot(root), { recursive: true });
    writeFileSync(join(logsRoot(root), MEMORY_KILLS_FILE), kills.map((kill) => `${JSON.stringify(kill)}\n`).join(""));
};

const guardKill = (over: Partial<MemoryKill> = {}): MemoryKill => ({
    at: NOW - 20_000,
    killer: "netd-guard",
    pid: 4242,
    comm: "cargo",
    rssBytes: 12 * 1024 ** 3,
    owner: "wise-fern-usz1",
    jobId: "job-7",
    reason: "memory pressure 61% for 30 s",
    ...over,
});

// The death as the failure frame finds it on this conversation's turn, with the daemon's own records asked about it.
const dyingIn = (conversationId: string, turn: Partial<FailureContext["turn"]> = {}, at = NOW): FailureContext => ({
    turn: { ...PROFILE, prompt: "build the parser", messageId: "m-parser", conversationId, ...turn },
    turnId: "t-1",
    provider: "claude",
    model: "opus",
    account: "acct",
    attribution: { account: "acct" },
    sessionId: `s-${conversationId}`,
    answered: true,
    remint: undefined,
    limitReset: undefined,
    outage: undefined,
    standing,
    checklist: undefined,
    contextTokens: 9_000,
    now: at,
});

// The records' questions as the daemon answers them (failure-queries.ts), with the conversation's own two: its answers
// read from the settings, and a stop ladder that records each time it is asked.
const queriesOf = (services: Services, ladder: string[] = []): FailureQueries => {
    const records = recordQueries(services);
    return {
        ...records,
        breakPolicy: async (_conversationId, ending): Promise<TurnBreakPolicy> => {
            const settings = await services.sandboxSettings.get();
            return ending === "memoryKill" ? settings.memoryKillPolicy : ending === "stopped" ? settings.stopPolicy : "wait";
        },
        stopLadder: (conversationId) => {
            ladder.push(conversationId);
            return { made: 0, nextAt: NOW + 5_000 };
        },
    };
};

// The turn begun, its death classified, and its hold given to the conversation as the settlement gives it.
const dieIn = async (fleet: Awaited<ReturnType<typeof fleetOn>>, context: FailureContext, ladder: string[] = []) => {
    const id = context.turn.conversationId ?? "";
    if (fleet.conversations.state(id)?.phase.kind !== "running") {
        await beginTurn(fleet.conversations, { conversationId: id, isolated: true, prompt: context.turn.prompt, profile: PROFILE }, context.now - 60_000);
    }
    const plan = await classifyFailure(KILLED, context, queriesOf(fleet.services, ladder));
    if (plan.held !== undefined) {
        fleet.conversations.send(id, { kind: "turn-held", held: plan.held }, context.now);
    }
    await fleet.conversations.send(id, { kind: "settle" }, context.now).settled;
    return plan;
};

describe("a runtime memory killed while the daemon stayed up", () => {
    test("is held for room rather than the stop ladder, told what was killed, and goes once memory has stayed free", async () => {
        const fleet = await fleetOn(["bold-wren-k2j4"]);
        await fleet.services.sandboxSettings.set({ ...(await fleet.services.sandboxSettings.get()), stopPolicy: "retry" });
        const kill = guardKill();
        recordKills(fleet.root, [kill]);
        const ladder: string[] = [];
        const plan = await dieIn(fleet, dyingIn("bold-wren-k2j4"), ladder);

        expect(plan.frame).toStrictEqual({ ...KILLED, message: `${KILLED.message}. ${GOES_WHEN_ROOM}`, held: { ran: true, contextTokens: 9_000, memoryKill: true }, autoResume: "scheduled" });
        expect(plan.held).toMatchObject({ reason: "stopped", ran: true, memoryKill: { reruns: 0, found: killSentence(kill) } });
        expect(plan.held?.pressOnly).toBeUndefined();
        // Never put on the ladder: its five seconds would send it back into the shortage that killed it.
        expect(ladder).toEqual([]);
        expect(await passAt(fleet, NOW + 5_000)).toEqual([]);
        expect(await passAt(fleet, NOW + 60_000)).toEqual([]);

        fleet.room.since = NOW + 60_000;
        expect(await passAt(fleet, NOW + 60_000 + ROOM_SETTLE_MS)).toEqual(["bold-wren-k2j4"]);
        const [rerun] = fleet.started;
        expect(rerun?.resume).toBe("memory");
        expect(rerun?.sessionId).toBe("s-bold-wren-k2j4");
        expect(rerun?.prompt.startsWith(RESUME_NOTES.memory)).toBe(true);
        expect(rerun?.prompt).toContain(`What the sandbox found: ${killSentence(kill)}`);
        // Killed under a running daemon, nothing else of the sandbox's ended: the restart's losses are not told.
        expect(rerun?.prompt).not.toContain(RESTART_LOSSES);
    });

    test("whose own process was the one killed is held for a press, with the kill on its notice", async () => {
        const fleet = await fleetOn(["wise-fern-usz1"]);
        recordKills(fleet.root, [guardKill(), guardKill({ pid: 5151, comm: "node", owner: "calm-otter-x1y2", rssBytes: 1024 ** 3 })]);
        const plan = await dieIn(fleet, dyingIn("wise-fern-usz1"));

        expect(plan.frame.autoResume).toBe("available");
        expect(plan.frame.held).toMatchObject({ pressOnly: true, memoryKill: true });
        expect(plan.frame.message).toContain("the process killed was this conversation's own");
        expect(plan.frame.message).toContain("cargo (pid 4242, 12.0 GB resident) from background job job-7");
        expect(plan.held).toMatchObject({ pressOnly: true, memoryKill: { found: killSentence(guardKill()) } });
        fleet.room.since = NOW - 60 * 60_000;
        expect(await passAt(fleet, NOW + ROOM_SETTLE_MS)).toEqual([]);
        expect(held(fleet.conversations, "wise-fern-usz1")).toMatchObject({ pressOnly: true, fired: false });
    });

    test("waits for a press where the answer to a memory kill is to wait", async () => {
        const fleet = await fleetOn(["bold-wren-k2j4"]);
        await fleet.setPolicy("wait");
        recordKills(fleet.root, [guardKill()]);
        const plan = await dieIn(fleet, dyingIn("bold-wren-k2j4"));
        expect(plan.frame.message).toBe(`${KILLED.message}. ${WAITS_FOR_PRESS}`);
        expect(plan.frame.autoResume).toBe("available");
        fleet.room.since = NOW - 60 * 60_000;
        expect(await passAt(fleet, NOW + ROOM_SETTLE_MS)).toEqual([]);
    });

    test("goes on as a stop where nothing says memory killed it, or where the death was no kill at all", async () => {
        const fleet = await fleetOn(["bold-wren-k2j4"]);
        // A kill on record from long before this death says nothing of it.
        recordKills(fleet.root, [guardKill({ at: NOW - 60 * 60_000 })]);
        const ladder: string[] = [];
        const plan = await dieIn(fleet, dyingIn("bold-wren-k2j4"), ladder);
        expect(plan.held).toMatchObject({ reason: "stopped" });
        expect(plan.held?.memoryKill).toBeUndefined();
        expect(ladder).toEqual(["bold-wren-k2j4"]);

        const crashed = await classifyFailure({ kind: "error", message: "the harness crashed" }, dyingIn("bold-wren-k2j4"), queriesOf(fleet.services));
        expect(crashed.held?.memoryKill).toBeUndefined();
    });
});

describe("a request memory kills every time it runs", () => {
    test(`comes back ${String(MEMORY_KILL_RERUNS)} times, then is held for a press as the likely cause; a new message starts from none`, async () => {
        const fleet = await fleetOn(["bold-wren-k2j4"]);
        recordKills(fleet.root, [guardKill()]);
        const id = "bold-wren-k2j4";
        let at = NOW;
        let context = dyingIn(id, {}, at);
        for (let rerun = 0; rerun < MEMORY_KILL_RERUNS; rerun += 1) {
            const plan = await dieIn(fleet, context);
            expect(plan.held).toMatchObject({ memoryKill: { reruns: rerun } });
            expect(plan.held?.pressOnly).toBeUndefined();
            expect(plan.frame.retries).toEqual(rerun === 0 ? undefined : { made: rerun, max: MEMORY_KILL_RERUNS });
            fleet.room.since = at;
            expect(await passAt(fleet, at + ROOM_SETTLE_MS)).toEqual([id]);
            const sent = fleet.started.at(-1);
            if (sent === undefined) {
                throw new Error("the release sent nothing");
            }
            at += ROOM_SETTLE_MS + 60_000;
            // The re-run, killed again before long, by the same kind of kill.
            recordKills(fleet.root, [guardKill({ at: at - 10_000 })]);
            context = dyingIn(id, { prompt: sent.prompt, ...opt("resume", sent.resume) }, at);
        }
        const third = await dieIn(fleet, context);
        expect(third.held).toMatchObject({ pressOnly: true, memoryKill: { reruns: MEMORY_KILL_RERUNS } });
        expect(third.frame.message).toBe(`${KILLED.message}. ${KILLED_AGAIN}`);
        expect(KILLED_AGAIN).toContain("killed for memory twice");
        expect(third.frame.autoResume).toBe("available");
        fleet.room.since = at - 60 * 60_000;
        expect(await passAt(fleet, at + ROOM_SETTLE_MS)).toEqual([]);
        expect(fleet.started).toHaveLength(MEMORY_KILL_RERUNS);

        // The person's next message is another request: the count starts again.
        const fresh = await dieIn(fleet, dyingIn(id, { prompt: "build the lexer instead", messageId: "m-lexer" }, at + 120_000));
        expect(fresh.held).toMatchObject({ memoryKill: { reruns: 0 } });
        expect(fresh.held?.pressOnly).toBeUndefined();
    });
});
