import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { isolatedAgent } from "./agents-store.testing.js";
import type { AgentArchiveDeps } from "./archive.js";
import { checkoutStanding, type CheckoutStandingDeps } from "./checkout-standing.js";
import { createLogger } from "../../logger.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const card = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
    id: "c1",
    status: "idle",
    provider: "claude",
    harness: "native",
    branch: "agent/c1",
    updatedAt: 7,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    ...overrides,
});

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "checkout-standing-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

// One conversation's directory on disk, and a registry naming `cards`; nothing runs unless a case says so.
const standingDeps = async (cards: readonly AgentSummary[], options: { running?: string; jobs?: number } = {}): Promise<CheckoutStandingDeps> => {
    await mkdir(join(root, "worktrees", "c1", "src"), { recursive: true });
    const archive = unstubbed<AgentArchiveDeps>("archive", {
        agents: unstubbed<AgentArchiveDeps["agents"]>("agents", {
            list: () => [...cards],
            entry: () => {
                const entry = isolatedAgent([]);
                return { ...entry, social: { ...entry.social, title: { text: "Fix the login bug", source: "derived" } } };
            },
        }),
        conversations: unstubbed<AgentArchiveDeps["conversations"]>("conversations", { running: (id) => id === options.running, state: () => undefined }),
        agentWorktrees: unstubbed<AgentWorktrees>("worktrees", {}),
        turns: { stop: async () => ({ stopped: false }) },
        turnEngine: { familyOf: (_, heads) => ({ heads, members: [], records: new Map() }), cancelFamily: async () => [], cancelWatchersFor: async () => 0 },
        logger,
    });
    return {
        archive,
        runningJobs: () => options.jobs ?? 0,
        leftovers: {
            historyRoot: root,
            worktreesRoot: join(root, "worktrees"),
            registry: { ids: () => cards.map((one) => one.id) },
            owners: { has: (id) => cards.some((one) => one.id === id), any: () => cards.length > 0, recreated: false },
            logger: { info: () => undefined, warn: () => undefined },
        },
        now: () => 1000,
    };
};

test("a settled conversation may have its build output cleaned and its checkout freed", async () => {
    expect(await checkoutStanding(await standingDeps([card()]), "c1")).toEqual({
        state: "idle",
        title: "Fix the login bug",
        updatedAt: 7,
        reapable: true,
        releasable: true,
        trashable: false,
    });
    expect((await checkoutStanding(await standingDeps([card({ status: "ready" })]), "c1"))?.state).toBe("held");
    expect((await checkoutStanding(await standingDeps([card({ status: "landed" })]), "c1"))?.state).toBe("landed");
});

test("work in flight, a background command included, reads as working and allows nothing", async () => {
    for (const deps of [await standingDeps([card({ status: "running" })]), await standingDeps([card()], { jobs: 1 }), await standingDeps([card()], { running: "c1" })]) {
        expect(await checkoutStanding(deps, "c1")).toMatchObject({ state: "working", reapable: false, releasable: false, trashable: false });
    }
});

test("an archived conversation's checkout may still be freed, and one nobody owns is a leftover for the trash", async () => {
    expect(await checkoutStanding(await standingDeps([card({ status: "landed", archivedAt: 1 })]), "c1")).toMatchObject({
        state: "archived",
        reapable: false,
        releasable: true,
    });
    const nobody = await standingDeps([card({ id: "other" })]);
    expect(await checkoutStanding(nobody, "c1")).toEqual({ state: "leftover", reapable: false, releasable: false, trashable: true });
    // Gone from the disk since the scan: no row.
    expect(await checkoutStanding(nobody, "c2")).toBe(undefined);
});
