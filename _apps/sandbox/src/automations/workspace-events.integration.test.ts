import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Automation, WorkspaceEvent } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { fileTurnJournal } from "../agent/turn-journal.js";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { fileApprovalsStore } from "./approvals-store.js";
import { fileAutomationsStore } from "./automations-store.js";
import type { WakeFn } from "./scheduler.js";
import { dispatchWorkspaceEvent } from "./workspace-events.js";

// Same shape as scheduler.test's fake — the dispatcher reaches only automations/approvals/activity/workspace/logger.
const fakeServices = (root: string): Services =>
    unstubbed<Services>("services", {
        automations: fileAutomationsStore(join(root, "automations.json")),
        approvals: fileApprovalsStore(join(root, "approvals")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], open: async () => {}, append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });

const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        prompts.push(input.prompt);
        yield* events;
    };

// A wake that parks until the test releases it — how overlap is observed without racing on timers.
const blockingWake = (prompts: string[]): { wake: WakeFn; release: () => void } => {
    let unblock = (): void => {};
    const gate = new Promise<void>((resolve) => {
        unblock = resolve;
    });
    return {
        release: () => unblock(),
        wake: async function* (_services, input) {
            prompts.push(input.prompt);
            await gate;
            yield { kind: "done" };
        },
    };
};

const chore = (id: string, extra: Partial<Automation> = {}): Automation => ({
    id,
    trigger: { kind: "workspace", event: "turn.settled" },
    prompt: `review:${id}`,
    enabled: true,
    ...extra,
});

const event = (agentId: string, extra: Partial<WorkspaceEvent> = {}): WorkspaceEvent => ({
    event: "turn.settled",
    agentId,
    branch: `agent/${agentId}`,
    outcome: "landed",
    repos: [{ repo: "root", from: "abc123", dir: `/history/worktrees/${agentId}` }],
    ...extra,
});

test("a matching enabled chore wakes with the event as its payload", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "chore-")));
    await services.automations.upsert(chore("review"));
    const prompts: string[] = [];

    expect(await dispatchWorkspaceEvent(services, event("a1"), fakeWake(prompts))).toEqual(["review"]);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("review:review");
    expect(prompts[0]).toContain(`"agentId":"a1"`);
    await vi.waitFor(async () => expect((await services.automations.get("review"))?.runs[0]?.outcome).toBe("completed"));
});

test("disabled chores, other events and other repos never fire", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "chore-")));
    await services.automations.upsert(chore("off", { enabled: false }));
    await services.automations.upsert(chore("landed-only", { trigger: { kind: "workspace", event: "agent.landed" } }));
    await services.automations.upsert(chore("api-only", { trigger: { kind: "workspace", event: "turn.settled", repo: "api" } }));
    await services.automations.upsert({ ...chore("cron"), trigger: { kind: "schedule", cron: "* * * * *" } });
    const prompts: string[] = [];

    expect(await dispatchWorkspaceEvent(services, event("a1"), fakeWake(prompts))).toEqual([]);
    expect(prompts).toEqual([]);

    // The repo filter matches on the event's own span, so the same chore fires once that repo is in it.
    const inApi = event("a2", { repos: [{ repo: "api", from: "def456", dir: "/history/worktrees/a2/api" }] });
    expect(await dispatchWorkspaceEvent(services, inApi, fakeWake(prompts))).toEqual(["api-only"]);
});

test("a burst QUEUES instead of dropping — every distinct agent gets reviewed, one turn at a time", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "chore-")));
    await services.automations.upsert(chore("review"));
    const prompts: string[] = [];
    const { wake, release } = blockingWake(prompts);

    await dispatchWorkspaceEvent(services, event("a1"), wake);
    await dispatchWorkspaceEvent(services, event("a2"), wake);
    await dispatchWorkspaceEvent(services, event("a3"), wake);
    // Serial: the first turn is running and holds the queue, so nothing else has woken yet.
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain(`"agentId":"a1"`);

    release();
    await vi.waitFor(() => expect(prompts).toHaveLength(3));
    expect(prompts[1]).toContain(`"agentId":"a2"`);
    expect(prompts[2]).toContain(`"agentId":"a3"`);
});

test("a second event for a waiting agent REPLACES it rather than queueing a duplicate review", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "chore-")));
    await services.automations.upsert(chore("review"));
    const prompts: string[] = [];
    const { wake, release } = blockingWake(prompts);

    await dispatchWorkspaceEvent(services, event("a1"), wake);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    // Both land behind the running turn; the second supersedes the first, so a2 is reviewed ONCE, as "error".
    await dispatchWorkspaceEvent(services, event("a2", { outcome: "conflict" }), wake);
    await dispatchWorkspaceEvent(services, event("a2", { outcome: "error" }), wake);

    release();
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).toContain(`"outcome":"error"`);
});

test("two different chores on one event do not run their turns at the same time", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "chore-")));
    await services.automations.upsert(chore("review"));
    await services.automations.upsert(chore("docs"));
    const prompts: string[] = [];
    const { wake, release } = blockingWake(prompts);

    // Both match, so both queue — but a chore turn runs on the shared /work tree, so only one may be running.
    expect(await dispatchWorkspaceEvent(services, event("a1"), wake)).toEqual(["review", "docs"]);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));

    release();
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
});

test("a chore disabled while its backlog waits does not run", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "chore-")));
    await services.automations.upsert(chore("review"));
    const prompts: string[] = [];
    const { wake, release } = blockingWake(prompts);

    await dispatchWorkspaceEvent(services, event("a1"), wake);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    await dispatchWorkspaceEvent(services, event("a2"), wake);
    await services.automations.upsert(chore("review", { enabled: false }));

    release();
    // The queue re-reads the manifest per event, so the waiting one is abandoned, not run.
    await vi.waitFor(async () => expect((await services.automations.get("review"))?.runs).toHaveLength(1));
    expect(prompts).toHaveLength(1);
});
