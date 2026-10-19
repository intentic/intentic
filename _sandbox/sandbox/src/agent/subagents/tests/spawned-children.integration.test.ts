import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import {
    KEPT_REPORT_CHARS,
    restoredFate,
    type RestoredFacts,
    SETTLED_KEPT_MS,
    type SpawnedChild,
    spawnedChildren,
    spawnedChildrenDocument,
    specFromFile,
    specOnFile,
} from "../spawned-children.js";

import type { Services } from "../../../composition.js";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { openConversationsDb } from "../../../store/conversations-db.js";
import { fleetStoreOver, memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { conversationEntry } from "../../../conversations/registry/agents-store.testing.js";
import type { Fleet } from "../../../conversations/registry/agents-registry.js";
import { spawnServices } from "../../../harness/spawn-services.testing.js";
import { drivenBy } from "../../../seams/turn-starter.testing.js";
import type { TurnStarter } from "../../../seams/turn-starter.js";
import { startTurnRun } from "../../run/turn/turn-runs.js";
import { createDomainEvents } from "../../../seams/domain-events.js";
import { answerChild, cancelChild, resetChildrenForTest, sendToChild, spawnChild } from "../children.js";
import { SEATS } from "../child-records.js";
import { FAN_OUT } from "../fan-out-governor.js";
import { restoreSpawnedChildren, settleRestoredChildren } from "../child-restore.js";
import { waitForSubagent } from "../subagents.js";
import { noteQueuedReport, queuedChildReportId } from "../queued-reports.js";
import { waitForWork } from "../work-wait.js";

// What a parent supervises its spawned children by, on file across a restart: the boot's decision for each child, and
// the files themselves.

const NOW = 50 * 24 * 3_600_000;
const child = (over: Partial<SpawnedChild> = {}): SpawnedChild => ({
    parent: "conv-parent",
    spec: { prompt: "Port the parser", provider: "claude", model: "claude-sonnet-4-6" },
    depth: 1,
    cwd: WORKSPACE_ROOT,
    startedAt: NOW - 1_000,
    state: "settled",
    ending: { status: "completed", at: NOW - 500 },
    turns: 1,
    at: NOW - 500,
    ...over,
});
const facts = (over: { child?: RestoredFacts["child"] | null; parent?: RestoredFacts["parent"] | null } = {}): RestoredFacts => ({
    child: over.child === null ? undefined : (over.child ?? { parent: "conv-parent" }),
    parent: over.parent === null ? undefined : (over.parent ?? { archived: false }),
});
const quiet = { warn: () => {} };

describe("what the boot does with a child on file", () => {
    it("brings back a child its parent still supervises", () => {
        expect(restoredFate(child(), facts(), NOW)).toEqual({ kind: "restore" });
    });

    it("strikes off one whose parent is gone or archived, naming which", () => {
        expect(restoredFate(child(), facts({ parent: null }), NOW)).toEqual({ kind: "drop", why: "the parent's conversation is gone" });
        expect(restoredFate(child(), facts({ parent: { archived: true } }), NOW)).toEqual({ kind: "drop", why: "the parent is archived" });
    });

    it("strikes off one whose own conversation is gone, or that the registry says another conversation started", () => {
        expect(restoredFate(child(), facts({ child: null }), NOW)).toEqual({ kind: "drop", why: "the child's conversation is gone" });
        expect(restoredFate(child(), facts({ child: { parent: "conv-other" } }), NOW)).toEqual({ kind: "drop", why: "the registry names another parent" });
    });

    it("lets a settled one go a fortnight after its ending, and never a running one", () => {
        const old = NOW - SETTLED_KEPT_MS - 1;
        expect(restoredFate(child({ ending: { status: "completed", at: old } }), facts(), NOW)).toEqual({ kind: "drop", why: "it settled long ago" });
        expect(restoredFate(child({ ending: { status: "completed", at: old + 2 } }), facts(), NOW)).toEqual({ kind: "restore" });
        expect(restoredFate(child({ state: "running", ending: undefined, at: old }), facts(), NOW)).toEqual({ kind: "restore" });
    });
});

describe("a child's file", () => {
    it("is one file per child under the history volume, read back as written", async () => {
        const root = await mkdtemp(join(tmpdir(), "spawned-children-"));
        const ledger = spawnedChildren(root, quiet);
        ledger.write("sub-a", child({ result: { value: { tests: 12 } } }));
        ledger.write("sub-b", child({ state: "running", ending: undefined }));
        expect((await ledger.list()).toSorted((left, right) => left.id.localeCompare(right.id))).toEqual([
            { id: "sub-a", ...child({ result: { value: { tests: 12 } } }) },
            { id: "sub-b", ...child({ state: "running", ending: undefined }) },
        ]);
        expect(JSON.parse(await readFile(join(root, spawnedChildrenDocument.path, "sub-b.json"), "utf8"))).toMatchObject({ state: "running" });
    });

    it("keeps its writes in order, and is struck off whole", async () => {
        const root = await mkdtemp(join(tmpdir(), "spawned-children-"));
        const ledger = spawnedChildren(root, quiet);
        ledger.write("sub-a", child({ state: "running", ending: undefined }));
        ledger.write("sub-a", child());
        expect(await ledger.list()).toEqual([{ id: "sub-a", ...child() }]);
        ledger.forget("sub-a");
        expect(await ledger.list()).toEqual([]);
    });

    it("cuts a report where a wait cuts it", async () => {
        const root = await mkdtemp(join(tmpdir(), "spawned-children-"));
        const ledger = spawnedChildren(root, quiet);
        ledger.write("sub-a", child({ report: "x".repeat(KEPT_REPORT_CHARS + 50) }));
        const [onFile] = await ledger.list();
        expect(onFile?.report?.length).toBe(KEPT_REPORT_CHARS);
    });
});

describe("a spawn on file", () => {
    it("comes back as the spawn it was, every knob only where it was named", () => {
        const spawn = {
            prompt: "go",
            provider: "cursor",
            model: "composer-2.5",
            effort: "high",
            fallbacks: [{ provider: "claude", model: "claude-sonnet-4-6" }],
            result: { schema: { type: "string" } },
        };
        expect(specFromFile(specOnFile(spawn))).toEqual(spawn);
        expect(Object.keys(specOnFile({ prompt: "go", provider: "claude", model: "claude-sonnet-4-6" }))).toEqual(["prompt", "provider", "model"]);
    });
});

// Restart the actual fleet, not just the child index: none of the old holdings or card waiters can answer these tests.
const parent = { conversationId: "conv-parent", cwd: WORKSPACE_ROOT };
const spec = (prompt: string) => ({ prompt, provider: "claude", model: "claude-sonnet-4-6" });
const heldFixture = async (settings: Partial<SandboxSettings> = {}) => {
    const root = await mkdtemp(join(tmpdir(), "held-children-"));
    const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
    store.agents.save([conversationEntry({ id: parent.conversationId })]);
    const servicesFor = (fleet: Fleet, body: TurnStarter["stream"]): Services => drivenBy({
        ...spawnServices(settings, [], fleet.conversations),
        agents: fleet.agents,
        config: { ...spawnServices(settings).config, historyRoot: root },
    }, body);
    const before = memoryFleet(store);
    await before.agents.init();
    const reboot = async (body: TurnStarter["stream"]) => {
        await spawnedChildren(root, quiet).list();
        resetChildrenForTest(before.conversations);
        const fleet = memoryFleet(store);
        await fleet.agents.init();
        const services = servicesFor(fleet, body);
        const cut = await restoreSpawnedChildren(services);
        return { fleet, services, cut };
    };
    return { root, before, servicesFor, reboot };
};

const endedIn = (fleet: Fleet, id: string) => waitForSubagent(fleet.conversations, parent.conversationId, { target: id, until: ["finished"], timeoutMs: 5_000 });
const spawned = async (services: Services, prompt: string): Promise<string> => {
    const result = await spawnChild(services, parent, spec(prompt));
    expect(result).toMatchObject({ ok: true, held: true });
    if (!result.ok) {
        throw new Error(result.message);
    }
    return result.id;
};
const recordTurns = (turns: string[]): TurnStarter["stream"] => async function* (turn) {
    turns.push(turn.prompt);
    yield { kind: "done" };
};

describe("starts held across a restart", () => {
    it("restores seat waits in order without child registry entries, keeps cancellation, and charges only starts", async () => {
        const kit = await heldFixture({ subagentsAtOnce: 1, subagentsPerTurn: 2 });
        const turns: string[] = [];
        const services = kit.servicesFor(kit.before, recordTurns(turns));
        kit.before.conversations.holdings(SEATS).hold(parent.conversationId, parent.conversationId, { live: 1, total: 0 });
        const first = await spawned(services, "first");
        const cancelled = await spawned(services, "cancelled");
        const last = await spawned(services, "last");
        expect((await spawnedChildren(kit.root, quiet).list()).map((entry) => entry.state)).toEqual(["held", "held", "held"]);
        const restored = await kit.reboot(recordTurns(turns));
        expect(restored.cut).toEqual([first, cancelled, last]);
        expect(await sendToChild(restored.services, parent, first, "hello")).toEqual({ ok: false, message: "It has not started: it waits for one of your running children to end, since you are at the most that may run at once. Wait for it, then send again." });
        expect(await answerChild(restored.services, parent, first, {})).toEqual({ ok: false, message: "It is not waiting on anything right now." });
        expect(await cancelChild(restored.services, parent, cancelled)).toMatchObject({ ok: true });
        await spawnedChildren(kit.root, quiet).list();
        // Crash again before the boot has re-armed the waiters: the cancelled child must stay cancelled.
        resetChildrenForTest(restored.fleet.conversations);
        const again = await kit.reboot(recordTurns(turns));
        expect(await endedIn(again.fleet, cancelled)).toMatchObject({ outcome: "finished", matched: { status: "killed" } });
        await settleRestoredChildren(again.services, again.cut);
        expect(await endedIn(again.fleet, last)).toMatchObject({ outcome: "finished", matched: { status: "completed" } });
        expect(turns).toEqual(["first", "last"]);
        expect(again.fleet.conversations.holdings(SEATS).get(parent.conversationId)).toEqual({ live: 0, total: 2 });
        expect(await spawnChild(again.services, parent, spec("past budget"))).toEqual({ ok: false, message: "This conversation has started 2 child turns, its lifetime budget." });
    });

    it("restores lane reservations, refunds a cancelled one, and starts the others in their original order", async () => {
        const kit = await heldFixture({ subagentsAtOnce: 3, subagentsPerTurn: 3 });
        const turns: string[] = [];
        const services = kit.servicesFor(kit.before, recordTurns(turns));
        FAN_OUT.admit("probe", spec("probe"), undefined);
        const first = await spawned(services, "first");
        const cancelled = await spawned(services, "cancelled");
        const last = await spawned(services, "last");
        const restored = await kit.reboot(recordTurns(turns));
        expect(restored.cut).toEqual([first, cancelled, last]);
        expect(restored.fleet.conversations.holdings(SEATS).get(parent.conversationId)).toEqual({ live: 3, total: 3 });
        expect(await sendToChild(restored.services, parent, last, "hello")).toEqual({ ok: false, message: "It has not started: it waits for a sibling on its provider to be answered first, or for a seat on it to free. Wait for it, then send again." });
        expect(await cancelChild(restored.services, parent, cancelled)).toMatchObject({ ok: true });
        expect(restored.fleet.conversations.holdings(SEATS).get(parent.conversationId)).toEqual({ live: 2, total: 2 });
        await settleRestoredChildren(restored.services, restored.cut);
        expect(await endedIn(restored.fleet, last)).toMatchObject({ outcome: "finished", matched: { status: "completed" } });
        expect(turns).toEqual(["first", "last"]);
        expect(restored.fleet.conversations.holdings(SEATS).get(parent.conversationId)).toEqual({ live: 0, total: 2 });
    });

    it("re-raises the owner's approval card and runs only after it is allowed", async () => {
        const kit = await heldFixture({ actionRules: { "agents.spawn": "hold" } });
        const turns: string[] = [];
        const services = kit.servicesFor(kit.before, recordTurns(turns));
        const oldRun = holdParent(kit.before);
        const id = await spawned(services, "approved");
        const restored = await kit.reboot(recordTurns(turns));
        const live = holdParent(restored.fleet);
        try {
            await settleRestoredChildren(restored.services, restored.cut);
            expect(turns).toEqual([]);
            const requestId = live.run.rows.findLast((row) => row.permission?.status === "pending")?.permission?.requestId;
            expect(typeof requestId).toBe("string");
            if (requestId === undefined) {
                throw new Error("no restored approval card");
            }
            expect(restored.services.cards.resolve({ kind: "permission", requestId, decision: "once" })).toBe("settled");
            expect(await endedIn(restored.fleet, id)).toMatchObject({ outcome: "finished", matched: { status: "completed" } });
            expect(turns).toEqual(["approved"]);
        } finally {
            live.release();
            oldRun.release();
        }
    });

    it("fails an owner hold clearly when its parent has no resumed turn to raise a card on", async () => {
        const kit = await heldFixture({ actionRules: { "agents.spawn": "hold" } });
        const turns: string[] = [];
        const live = holdParent(kit.before);
        const id = await spawned(kit.servicesFor(kit.before, recordTurns(turns)), "needs owner");
        const restored = await kit.reboot(recordTurns(turns));
        await settleRestoredChildren(restored.services, restored.cut);
        expect(await endedIn(restored.fleet, id)).toMatchObject({ outcome: "finished", matched: { status: "failed", error: expect.stringContaining("there is no live turn on which to raise its approval card") } });
        expect(turns).toEqual([]);
        expect((await spawnedChildren(kit.root, quiet).list())[0]).toMatchObject({ state: "settled", ending: { status: "failed" } });
        live.release();
    });
});

const holdParent = (fleet: Fleet) => {
    const held = Promise.withResolvers<void>();
    const body: TurnStarter["stream"] = async function* () {
        await held.promise;
        yield { kind: "done" };
    };
    const run = startTurnRun({ conversations: fleet.conversations, events: createDomainEvents(() => {}) }, body, { conversationId: parent.conversationId, prompt: "parent" });
    if (typeof run === "string") {
        throw new Error(run);
    }
    return { run, release: () => held.resolve() };
};

it("withdraws a queued child report after a fresh fleet and the real boot restore lost the in-memory report index", async () => {
    const kit = await heldFixture();
    const services = kit.servicesFor(kit.before, recordTurns([]));
    spawnedChildren(kit.root, quiet).write("sub-queued", child({ parent: parent.conversationId, at: Date.now(), ending: { status: "completed", at: Date.now() }, turns: 0, report: "ported" }));
    const messageId = queuedChildReportId("sub-queued");
    await kit.before.conversations.send(parent.conversationId, {
        kind: "queue-joined",
        item: { id: messageId, voice: "sandbox", queuedAt: Date.now(), turn: { conversationId: parent.conversationId, prompt: "Child report", messageId } },
    }).settled;
    noteQueuedReport(services.conversations, "sub-queued", { parent: parent.conversationId, messageId });
    const restored = await kit.reboot(recordTurns([]));
    expect(restored.fleet.conversations.queued(parent.conversationId).items.map((item) => item.id)).toEqual([messageId]);
    expect(await waitForWork(restored.fleet.conversations, parent.conversationId, { target: "sub-queued", until: ["finished"], timeoutMs: 5_000 })).toMatchObject({ outcome: "finished", agent: { id: "sub-queued" } });
    expect(restored.fleet.conversations.queued(parent.conversationId).items).toEqual([]);
});
