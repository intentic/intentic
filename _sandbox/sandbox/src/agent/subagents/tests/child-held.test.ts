import { WORKSPACE_ROOT } from "@intentic/constants";
import { createHoldingsIndex } from "../../../conversations/actor/conversation-holdings.js";
import type { LandStanding } from "../../../conversations/land/standing.js";
import { isolatedAgent } from "../../../conversations/registry/agents-store.testing.js";
import type { IsolatedAgent } from "../../../conversations/registry/agents-store.js";
import type { LandOutcome } from "../../../conversations/land/land.js";
import { heldChildrenOf, type HeldWorkDeps, settleHeldChild } from "../child-held.js";

// 2026-10-20: an orchestrator ported two held children into its checkout by hand, kept a third back on purpose, and landed;
// its card read "3 need you". The parent now says which held work it already brought in, and is told which it left held.

const parent = { conversationId: "p", cwd: WORKSPACE_ROOT };
const report = [{ repo: "root", paths: [{ path: "a.ts", reason: "diverged" as const }], clean: 0 }];

const child = (id: string, overrides: Partial<IsolatedAgent> = {}): IsolatedAgent =>
    isolatedAgent([], { id, identity: { startedBy: "agent:p" }, landing: { conflicts: report }, ...overrides });

// A registry over `entries`, each standing as `standing` says, with the land writes kept to read back.
const fleet = (entries: readonly IsolatedAgent[], standing: Record<string, LandStanding>, running: readonly string[] = []) => {
    const recorded: { id: string; outcome: LandOutcome }[] = [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const services: HeldWorkDeps = {
        agents: {
            ids: () => [...byId.keys()],
            entry: (id) => byId.get(id),
            standingOf: (id) => standing[id] ?? "idle",
            recordLanded: async (id, outcome) => {
                recorded.push({ id, outcome });
            },
        },
        conversations: {
            running: (id) => running.includes(id),
            holdings: createHoldingsIndex(() => undefined).holdings,
            withLandLease: (_id, task) => task(),
        },
        agentWorktrees: { mainDir: () => WORKSPACE_ROOT },
        logger: { info: () => undefined },
    };
    return { services, recorded };
};

describe("a parent's children whose work is still held", () => {
    it("are its own resting children in a land conflict, and none it settled, archived, or someone else's", () => {
        const { services } = fleet(
            [
                child("held", { social: { title: { text: "Follow-up B", source: "derived" }, reactions: [] } }),
                child("landed"),
                child("working"),
                child("filed", { archivedAt: 1 }),
                child("theirs", { identity: { startedBy: "agent:q" } }),
            ],
            { held: "conflict", landed: "landed", working: "conflict", filed: "conflict", theirs: "conflict" },
            ["working"],
        );
        expect(heldChildrenOf(services, "p")).toEqual([{ id: "held", title: "Follow-up B" }]);
    });
});

describe("settling a held child", () => {
    it("records its work as landed, writing nothing, and it is no longer held", async () => {
        const { services, recorded } = fleet([child("held")], { held: "conflict" });
        await expect(settleHeldChild(services, parent, "held")).resolves.toEqual({ ok: true, note: expect.stringContaining("Recorded as brought in") });
        expect(recorded).toEqual([{ id: "held", outcome: expect.objectContaining({ landed: true, changed: false, adjudicated: true, conflicts: [] }) }]);
    });

    it("records nothing for a child whose work nothing holds", async () => {
        const { services, recorded } = fleet([child("landed")], { landed: "landed" });
        await expect(settleHeldChild(services, parent, "landed")).resolves.toEqual({ ok: true, note: expect.stringContaining("Nothing of it is held") });
        expect(recorded).toEqual([]);
    });

    it("waits for a child still working, and refuses another conversation's", async () => {
        const { services, recorded } = fleet([child("held"), child("theirs", { identity: { startedBy: "agent:q" } })], { held: "conflict", theirs: "conflict" }, [
            "held",
        ]);
        await expect(settleHeldChild(services, parent, "held")).resolves.toEqual({ ok: false, message: expect.stringContaining("still working") });
        await expect(settleHeldChild(services, parent, "theirs")).resolves.toEqual({ ok: false, message: "No such child of this conversation. `list` shows yours." });
        expect(recorded).toEqual([]);
    });
});
