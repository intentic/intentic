import { createHoldingsIndex, type Share } from "../../../conversations/actor/conversation-holdings.js";
import { ROSTER } from "../../../conversations/actor/subagent-roster.js";
import { isolatedAgent } from "../../../conversations/registry/agents-store.testing.js";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { ChildRecord } from "../children.js";
import { CHILDREN } from "../child-records.js";
import { retireIdleChildCheckouts } from "./child-checkout-retirement.js";

const NOW = 10_000_000;
const shares = new Map<string, Share>();
const holdings = createHoldingsIndex((holder, create) => {
    let share = shares.get(holder);
    if (share === undefined && create) {
        share = new Map();
        shares.set(holder, share);
    }
    return share;
}).holdings;
afterEach(() => {
    holdings(CHILDREN).clear();
    holdings(ROSTER).clear();
    shares.clear();
});
const makeKid = (overrides: Partial<ChildRecord> = {}): ChildRecord =>
    // SAFETY: the retirement tests exercise only the fields it reads; all other child state is irrelevant here.
    ({
        parent: "parent",
        spec: { prompt: "task", provider: "claude", model: "sonnet" },
        depth: 1,
        cwd: WORKSPACE_ROOT,
        startedAt: 0,
        running: false,
        queued: false,
        held: undefined,
        startHold: undefined,
        paused: undefined,
        pending: undefined,
        ...overrides,
    }) as ChildRecord;

const servicesFor = (ids: readonly string[], overrides: { readonly standing?: Record<string, string>; readonly running?: readonly string[] } = {}) => {
    const actors = { holdings };
    for (const [index, id] of ids.entries()) {
        holdings(CHILDREN).hold("parent", id, makeKid());
        // SAFETY: this fixture supplies the roster fields used by the sweep; no turn methods are called.
        holdings(ROSTER).hold("parent", id, { id, kind: "spawned", conversationId: "parent", status: "completed", startedAt: 0, endedAt: NOW - (ids.length - index) * 10_000, activityAt: NOW, turn: {} } as never);
    }
    const retired: string[] = [];
    const entries = new Map(ids.map((id) => [id, isolatedAgent([{ repo: "root", base: "a".repeat(40) }], { id })]));
    // SAFETY: each exercised service method is supplied and every omitted method is outside the tested retirement path.
    const services = {
        conversations: {
            holdings,
            running: (id: string) => overrides.running?.includes(id) ?? false,
            withLandLease: async <T>(_id: string, task: () => Promise<T>) => task(),
        },
        agents: {
            list: () => ids.map((id) => ({ id, queue: { items: [] } })),
            entry: (id: string) => entries.get(id),
            standingOf: (id: string) => overrides.standing?.[id] ?? "idle",
        },
        agentWorktrees: {
            presence: async (id: string) => (retired.includes(id) ? "restorable" : "present"),
            retire: async (id: string) => void retired.push(id),
        },
        logger: { warn: () => undefined },
    } as never;
    return { services, retired };
};

describe("idle child checkout retirement", () => {
    it("waits through the grace, then retires oldest idle children first", async () => {
        const { services, retired } = servicesFor(["older", "newer"]);
        expect(await retireIdleChildCheckouts(services, { now: NOW, graceMs: 30_000 })).toBe(0);
        expect(retired).toEqual([]);
        expect(await retireIdleChildCheckouts(services, { now: NOW + 10_000, graceMs: 30_000 })).toBe(1);
        expect(await retireIdleChildCheckouts(services, { now: NOW + 20_000, graceMs: 30_000 })).toBe(1);
        expect(retired).toEqual(["older", "newer"]);
    });

    it("leaves a live, queued, questioned, running, or unlanded child checkout alone", async () => {
        const { services, retired } = servicesFor(["live", "queued", "question", "running", "unlanded", "eligible"], { running: ["running"], standing: { unlanded: "ready" } });
        holdings(CHILDREN).get("live")!.running = true;
        holdings(CHILDREN).get("queued")!.queued = true;
        // SAFETY: the truthy discriminant is all this fixture needs to exercise the pending-question guard.
        holdings(CHILDREN).get("question")!.pending = { kind: "question" } as never;
        expect(await retireIdleChildCheckouts(services, { now: NOW, graceMs: 0 })).toBe(1);
        expect(retired).toEqual(["eligible"]);
    });

    it("stops as soon as the disk has enough space", async () => {
        const { services, retired } = servicesFor(["oldest", "next"]);
        expect(
            await retireIdleChildCheckouts(services, {
                now: NOW,
                graceMs: 0,
                enough: async () => retired.length > 0,
            }),
        ).toBe(1);
        expect(retired).toEqual(["oldest"]);
    });
});
