import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOrigin, AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { automationConfig } from "../../harness/route-stores.testing.js";
import type { Services } from "../../composition.js";
import { WEBCHAT_PROVIDER } from "../../webchat/webchat-config.js";
import { outboxKeyOf } from "../../webchat/webchat-outbox.js";
import type { AutomationRecord } from "../automations-store.js";
import { answeringWake, bootAutomations, daemonOn, hangingWake } from "./restart.testing.js";
import { automationIdle, createAutomationsScheduler, fireAutomation, recordHeldWake, runHeldWake } from "../scheduler.js";

// Restart durability of fires the scheduler admitted (../scheduler.ts, fire-admission.ts, ../fire-resume.ts): each test builds
// what a daemon had at the moment it died, kills it, and boots a second daemon on the same history with nothing of the
// first in memory, through the boot's own passes.

const visitor = (automationId: string, n: number): AgentOrigin => ({ automationId, provider: WEBCHAT_PROVIDER, channelId: `visitor-${n}` });

// The payload line a wake was handed, which names the fire in these tests.
const payloadOf = (prompt: string): string => /--- Event payload ---\n(\S+)/.exec(prompt)?.[1] ?? "";
const answerTo = (prompt: string): string => `answer:${payloadOf(prompt)}`;

// What a visitor's next poll would collect.
const repliesFor = async (services: Services, origin: AgentOrigin): Promise<string[]> => {
    const key = outboxKeyOf(origin);
    if (key === undefined) {
        throw new Error("not a Visitor chat origin");
    }
    return (await services.webchatOutbox.since(key, 0, Date.now())).replies.map((reply) => reply.text);
};

// The record as the manifest holds it now; a test that names one it never saved is broken.
const recordOf = async (services: Services, id: string): Promise<AutomationRecord> => {
    const found = await services.automations.get(id);
    if (found === undefined) {
        throw new Error(`no automation ${id}`);
    }
    return found;
};

const event = (id: string, extra: Parameters<typeof automationConfig>[1] = {}) => automationConfig(id, { trigger: { kind: "event" }, ...extra });

test("fires queued behind a running one, an approved hold among them, come back once each, in order, answering their visitors", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-fires-"));
    const cut: AgentTurn[] = [];
    const before = daemonOn(root, hangingWake(cut));
    await before.services.automations.upsert(event("desk"));
    const desk = await recordOf(before.services, "desk");
    void fireAutomation(before.services, desk, { payload: "one", origin: visitor("desk", 1), overlap: "queue" });
    await waitFor(() => expect(cut).toHaveLength(1), SETTLES);
    void fireAutomation(before.services, desk, { payload: "two", origin: visitor("desk", 2), overlap: "queue" });
    void fireAutomation(before.services, desk, { payload: "three", origin: visitor("desk", 3), overlap: "queue" });
    // A hold the owner approves while the automation is busy: queued behind it rather than dropped as overlapping.
    const hold = await before.services.heldWakes.add({ automationId: "desk", payload: "four", origin: visitor("desk", 4), createdAt: Date.now() });
    await before.services.heldWakes.approve(hold.id, "owner@example.com");
    const released = await before.services.heldWakes.release(hold.id, (wake) => recordHeldWake(before.services, wake));
    if (released === undefined) {
        throw new Error("the approved hold was not released");
    }
    void runHeldWake(before.services, desk, released);
    // One running, three waiting, every one of them on the journal; the hold left the queue only once it was there.
    await waitFor(async () => expect((await before.services.turnJournal.list()).map((entry) => entry.kind === "automation" && entry.state)).toEqual(["running", "queued", "queued", "queued"]), SETTLES);
    expect(await before.services.heldWakes.list()).toEqual([]);
    before.crash();

    const ran: AgentTurn[] = [];
    const after = daemonOn(root, answeringWake(ran, answerTo));
    await bootAutomations(after.services);
    await waitFor(() => expect(ran).toHaveLength(4), SETTLES);
    await automationIdle("desk", after.services);

    expect(ran.map((turn) => payloadOf(turn.prompt))).toEqual(["one", "two", "three", "four"]);
    // The cut fire continues on the conversation it was cut on.
    expect(ran[0]?.conversationId).toBe(cut[0]?.conversationId);
    for (const [n, word] of ["one", "two", "three", "four"].entries()) {
        expect(await repliesFor(after.services, visitor("desk", n + 1))).toEqual([`answer:${word}`]);
    }
    expect(await after.services.turnJournal.list()).toEqual([]);
    const runs = (await after.services.automations.get("desk"))?.runs ?? [];
    expect(runs.map((run) => run.outcome).toSorted()).toEqual(["completed", "completed", "completed", "completed", "interrupted"]);
});

test("an approved hold whose release died before taking it out of the queue runs once after the restart, and leaves the queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-fires-"));
    const before = daemonOn(root, hangingWake([]));
    await before.services.automations.upsert(event("gate"));
    const hold = await before.services.heldWakes.add({ automationId: "gate", payload: "approved", origin: visitor("gate", 1), createdAt: Date.now() });
    await before.services.heldWakes.approve(hold.id, "owner@example.com");
    const dying = before.services.heldWakes.release(hold.id, async (wake) => {
        await recordHeldWake(before.services, wake);
        throw new Error("the daemon died between journalling the release and taking the hold out");
    });
    await expect(dying).rejects.toThrow(/died/);
    expect((await before.services.heldWakes.list()).map((held) => held.id)).toEqual([hold.id]);
    before.crash();

    const ran: AgentTurn[] = [];
    const after = daemonOn(root, answeringWake(ran, answerTo));
    await bootAutomations(after.services);
    await waitFor(() => expect(ran).toHaveLength(1), SETTLES);
    await automationIdle("gate", after.services);

    expect(payloadOf(ran[0]?.prompt ?? "")).toBe("approved");
    expect(await after.services.heldWakes.list()).toEqual([]);
    expect(await repliesFor(after.services, visitor("gate", 1))).toEqual(["answer:approved"]);
    expect(await after.services.turnJournal.list()).toEqual([]);
});

test("a first-fire watch that died after retiring itself still runs the fire it retired for, on the check it passed", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-fires-"));
    const marker = join(root, "checked-once");
    // Passes once only: a restart that ran the check again would skip, and the change it waited for would be lost.
    const watch = event("first", { until: "first-fire", guard: `test ! -e ${marker} && touch ${marker} && echo ready` });
    const before = daemonOn(root, hangingWake([]), (method, phase) => method === "setEnabled" && phase === "after");
    await before.services.automations.upsert(watch);
    void fireAutomation(before.services, await recordOf(before.services, "first"));
    await waitFor(async () => expect((await before.services.turnJournal.list()).map((entry) => entry.kind === "automation" && entry.checked)).toEqual([true]), SETTLES);
    await waitFor(async () => expect((await daemonOn(root, hangingWake([])).services.automations.get("first"))?.enabled).toBe(false), SETTLES);

    const ran: AgentTurn[] = [];
    const after = daemonOn(root, answeringWake(ran, answerTo));
    await bootAutomations(after.services);
    await waitFor(() => expect(ran).toHaveLength(1), SETTLES);
    await automationIdle("first", after.services);

    expect(ran[0]?.prompt).toContain("ready");
    const first = await after.services.automations.get("first");
    expect(first?.enabled).toBe(false);
    expect(first?.runs.map((run) => run.outcome)).toEqual(["completed"]);
    expect(await after.services.turnJournal.list()).toEqual([]);
});

test("a watch that died before moving its baseline fires the change once after the restart, and not again", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-fires-"));
    const page = join(root, "page.txt");
    const watch = event("page", { fireOn: "change", guard: `cat ${page}` });
    let watchWrites = 0;
    // Dies at the second baseline write: the first only notes what to compare against, the second is the change's.
    const before = daemonOn(root, hangingWake([]), (method, phase) => method === "recordWatch" && phase === "before" && ++watchWrites === 2);
    await before.services.automations.upsert(watch);
    writeFileSync(page, "v1");
    await fireAutomation(before.services, await recordOf(before.services, "page"));
    writeFileSync(page, "v2");
    void fireAutomation(before.services, await recordOf(before.services, "page"));
    await waitFor(async () => expect((await before.services.turnJournal.list()).map((entry) => entry.kind === "automation" && entry.observedValue)).toEqual(["v2"]), SETTLES);

    const ran: AgentTurn[] = [];
    const after = daemonOn(root, answeringWake(ran, answerTo));
    await bootAutomations(after.services);
    await waitFor(() => expect(ran).toHaveLength(1), SETTLES);
    await automationIdle("page", after.services);
    expect(ran[0]?.prompt).toContain("v2");
    expect((await after.services.automations.get("page"))?.watch?.value).toBe("v2");

    // The baseline the replay moved holds: the same page again is nothing new.
    await fireAutomation(after.services, await recordOf(after.services, "page"));
    expect(ran).toHaveLength(1);
});

test("a one-time wake that died between journalling its fire and switching off runs once, and the next poll does not repeat it", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-fires-"));
    const at = Date.now() - 1_000;
    const before = daemonOn(root, hangingWake([]), (method, phase) => method === "setEnabled" && phase === "before");
    await before.services.automations.upsert(automationConfig("dentist", { trigger: { kind: "once", at } }));
    await createAutomationsScheduler(before.services).tick(Date.now());
    await waitFor(async () => expect((await before.services.turnJournal.list()).map((entry) => entry.kind === "automation" && entry.state)).toEqual(["queued"]), SETTLES);
    expect((await daemonOn(root, hangingWake([])).services.automations.get("dentist"))?.enabled).toBe(true);

    const ran: AgentTurn[] = [];
    const after = daemonOn(root, answeringWake(ran, answerTo));
    await bootAutomations(after.services);
    await waitFor(() => expect(ran).toHaveLength(1), SETTLES);
    await automationIdle("dentist", after.services);
    await createAutomationsScheduler(after.services).tick(Date.now());
    await automationIdle("dentist", after.services);

    expect(ran).toHaveLength(1);
    const dentist = await after.services.automations.get("dentist");
    expect(dentist?.enabled).toBe(false);
    expect(dentist?.runs.map((run) => run.outcome)).toEqual(["completed"]);
});
