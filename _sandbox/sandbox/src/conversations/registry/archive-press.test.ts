import { IN_MEMORY } from "@intentic/base/sqlite";
import { unstubbed } from "@intentic/testing";
import { openConversationsDb } from "../../store/conversations-db.js";
import { beginTurn } from "../actor/conversation-actors.testing.js";
import type { BeginTurn } from "../actor/conversation-decide.js";
import { noPresences } from "../land/tests/landed-presence.testing.js";
import { createLogger } from "../../logger.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";
import { archivableNow, archiveOnPress } from "./archive-press.js";
import { createFleet } from "./agents-registry.js";
import { fleetStoreOver } from "./agents-registry.testing.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const noStandings = { of: () => "idle" as const, causesOf: () => [], refresh: async () => false, forget: () => {} };
const turn = (conversationId: string): BeginTurn => ({
    conversationId,
    isolated: true,
    prompt: "Fix the login bug",
    profile: { agent: "claude", harness: "native" },
});

// Two conversations on the real store: `stopping`, whose stop is unwinding, and `working`, whose turn nobody stopped.
const fleet = async () => {
    const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), noStandings, noPresences());
    await agents.init();
    await beginTurn(conversations, turn("stopping"), 1_000);
    await conversations.send("stopping", { kind: "stop", ending: "stopped" }, 2_000).settled;
    await beginTurn(conversations, turn("working"), 1_000);
    const retire = jest.fn(async () => undefined);
    const deps = { agents, conversations, agentWorktrees: unstubbed<AgentWorktrees>("worktrees", { retire }), logger };
    return { agents, conversations, retire, deps };
};

describe("archiving a card that reads Stopping", () => {
    it("takes a stop under way and a settled conversation, and leaves a turn nobody stopped to the route's refusal", async () => {
        const { conversations } = await fleet();
        await beginTurn(conversations, turn("done"), 1_000);
        await conversations.send("done", { kind: "settle" }, 2_000).settled;

        expect(archivableNow(conversations, "stopping")).toBe(true);
        expect(archivableNow(conversations, "done")).toBe(true);
        expect(archivableNow(conversations, "working")).toBe(false);
    });

    it("files the conversation once its stop has wound down, not before", async () => {
        const { agents, conversations, retire, deps } = await fleet();

        const pressed = archiveOnPress(deps, ["stopping"], () => 9_000, 60_000);
        await Promise.resolve();
        expect(retire).not.toHaveBeenCalled();
        await conversations.send("stopping", { kind: "settle" }, 5_000).settled;

        expect(await pressed).toEqual({ archived: ["stopping"], failed: [] });
        expect(retire).toHaveBeenCalledTimes(1);
        expect(agents.get("stopping")?.archivedAt).toBe(9_000);
    });

    it("keeps a stop that outlasts the wait on the board, and says why", async () => {
        const { agents, retire, deps } = await fleet();

        const answer = await archiveOnPress(deps, ["stopping"], () => 9_000, 5);

        expect(answer).toEqual({ archived: [], failed: [{ id: "stopping", reason: "it is still stopping, archive it once it has stopped" }] });
        expect(retire).not.toHaveBeenCalled();
        expect(agents.get("stopping")?.archivedAt).toBeUndefined();
    });
});
