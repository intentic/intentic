import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { interruptedTurnsInFlight } from "../../agent/run/turn/recovery/cut-turns.js";
import { addListenerMessage } from "../../automations/durable/inbox-store.js";
import { automationInboxesInFlight } from "../../automations/fire-resume.js";
import type { Services } from "../../composition.js";
import type { QueuedItem } from "../../conversations/actor/conversation-queue.js";
import { conversationEntry } from "../../conversations/registry/agents-store.testing.js";
import { type InFlightFailed, readLeftWork, recoverLeftWork } from "../../seams/restart/in-flight.js";
import { RESUMES } from "../../seams/restart/in-flight.testing.js";
import { conversationUnit } from "../../store/conversation-units.js";
import type { JournalledTurn } from "../../store/journals/turn-journal.js";

// One record or store a boot cannot read or recover takes down only itself: an unreadable turn journal resumes no cut
// turn, but what waited in a conversation's queue still goes and the automation inboxes are still replayed (as before
// 2026-10-20, when the passes caught it themselves), and one cut turn whose recovery throws leaves the others to run.

// One message waiting on `conversationId`, sent while its turn ran.
const waiting = (conversationId: string): QueuedItem => ({
    id: `m-${conversationId}`,
    voice: "person",
    queuedAt: 500,
    revision: 1,
    turn: { conversationId, prompt: "and then the tests" },
});

const journalBroken = (): Promise<never> => Promise.reject(new Error("SQLITE_CORRUPT: database disk image is malformed"));

// A daemon whose conversations are `queued` (each with one message waiting) and whose journal lists `list`.
const servicesOver = (root: string, list: Services["turnJournal"]["list"], queued: readonly string[], drained: string[], over: Partial<Services> = {}) =>
    unstubbed<Services>("services", {
        turnJournal: unstubbed<Services["turnJournal"]>("turnJournal", { list }),
        agents: unstubbed<Services["agents"]>("agents", {
            ids: () => ["c1", ...queued.filter((id) => id !== "c1")],
            entry: (id: string) =>
                queued.includes(id) ? conversationEntry({ id, queue: { items: [waiting(id)], revision: 1 } }) : undefined,
        }),
        turns: unstubbed<Services["turns"]>("turns", {
            drain: async (id: string) => {
                drained.push(id);
            },
        }),
        config: unstubbed<Services["config"]>("config", { historyRoot: root }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {} }),
        ...over,
    });

const noted = (failures: string[]): InFlightFailed => (kind, stage) => failures.push(`${kind}: ${stage}`);

test("an unreadable turn journal resumes no cut turn, but the queues still drain and the inboxes are still replayed", async () => {
    const root = mkdtempSync(join(tmpdir(), "in-flight-failures-"));
    const drained: string[] = [];
    const services = servicesOver(root, journalBroken, ["c1"], drained);
    await addListenerMessage(services, {
        id: "inbox-1",
        automationId: "desk",
        line: JSON.stringify({ content: "first" }),
        context: { origin: { automationId: "desk", provider: "webchat", channelId: "ch1" }, title: "desk", thread: "desk:ch1", ttlMs: 60_000, lane: { requireApproval: false } },
    });
    const failures: string[] = [];

    await recoverLeftWork(await readLeftWork(services, [interruptedTurnsInFlight], noted(failures)), RESUMES, noted(failures));
    expect(drained).toEqual(["c1"]);

    // The journal only says which rows a cut fire already carries; unreadable, it carries none, and every row goes back.
    const inboxes = await readLeftWork(services, [automationInboxesInFlight], noted(failures));
    expect(inboxes.map((work) => work.count)).toEqual([1]);
    expect(failures).toEqual([]);
});

// A turn cut mid-run, as the journal holds it.
const cut = (conversationId: string, run: { readonly id: string; readonly settled?: true }): JournalledTurn => ({
    kind: "turn",
    startedAt: 1_000,
    attempts: 0,
    turn: { conversationId, prompt: "Fix the login bug" },
    run: { ...run, rows: [{ role: "user", text: "Fix the login bug", run: run.id }] },
});

test("one cut turn whose recovery throws is logged, and the turns after it and the queues still go", async () => {
    const root = mkdtempSync(join(tmpdir(), "in-flight-failures-"));
    // Its run's log cannot be read (a directory where the file should be): reading what it drew throws.
    mkdirSync(join(conversationUnit(root, "c-broken"), "running.jsonl"), { recursive: true });
    const entries = [cut("c-broken", { id: "r-broken" }), cut("c-settled", { id: "r-settled", settled: true })];
    const drained: string[] = [];
    const appended: string[] = [];
    const cleared: string[] = [];
    const errors: string[] = [];
    const services = servicesOver(root, async () => entries, ["c1"], drained, {
        turnJournal: unstubbed<Services["turnJournal"]>("turnJournal", {
            list: async () => entries,
            clearTurn: async (conversationId: string) => {
                cleared.push(conversationId);
            },
        }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            // Nothing on the record yet: every run is written.
            page: async () => ({ rows: [], from: 0, more: false }),
            append: async (agent: { readonly id: string }) => {
                appended.push(agent.id);
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", {
            info: () => {},
            warn: () => {},
            error: (fields: { readonly conversationId?: string }) => {
                errors.push(fields.conversationId ?? "");
            },
        }),
    });
    const failures: string[] = [];

    const turns = await readLeftWork(services, [interruptedTurnsInFlight], noted(failures));
    expect(turns.map((work) => work.count)).toEqual([2]);
    await recoverLeftWork(turns, RESUMES, noted(failures));

    // The settled one after the broken one is still written down, and the queue still goes; the broken one says so on
    // its own line and stays on file for the next boot.
    expect(appended).toEqual(["c-settled"]);
    expect(cleared).toEqual(["c-settled"]);
    expect(drained).toEqual(["c1"]);
    expect(errors).toEqual(["c-broken"]);
    expect(failures).toEqual([]);
});
