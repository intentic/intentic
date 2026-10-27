import { homeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { services as routeServices } from "../../harness/route-services.testing.js";
import { clearHomeHistory, startFreshHome } from "./home-fresh.routes.js";

// The two ways a person cleans up their own home conversation, on the loopback owner's home (no auth configured).

const HOME = homeConversationId("owner@loopback");
const ROWS: TranscriptRow[] = [
    { role: "user", text: "Make the parser faster" },
    { role: "assistant", text: "Done." },
];

// The record and its saved points, in memory: what the two presses cut.
const stores = () => {
    const rows: TranscriptRow[] = [];
    const checkpoints = { kept: Number.POSITIVE_INFINITY };
    const plain = routeServices({});
    return {
        checkpoints,
        overrides: {
            transcripts: {
                ...plain.transcripts,
                append: async (_agent: unknown, more: readonly TranscriptRow[]) => void rows.push(...more),
                count: async () => rows.length,
                truncate: async (_agent: unknown, keep: number) => rows.splice(keep).length,
            },
            turnCheckpoints: { ...plain.turnCheckpoints, truncate: async (_id: string, keep: number) => void (checkpoints.kept = keep) },
        },
    };
};

const homeWithHistory = async () => {
    const recorded = stores();
    const deps = routeServices(recorded.overrides);
    const profile = { provider: "claude", harness: "native" } as const;
    await deps.conversations.send(HOME, { kind: "begin", turn: { conversationId: HOME, prompt: "Make the parser faster", isolated: false, profile, home: true } }, 1)
        .settled;
    deps.conversations.send(HOME, { kind: "frame", frame: { kind: "session", sessionId: "session" } }, 2);
    await deps.conversations.send(HOME, { kind: "settle" }, 3).settled;
    await deps.transcripts.append({ id: HOME }, ROWS);
    return { deps, checkpoints: recorded.checkpoints };
};

test("Start fresh lets the old session go and marks the next turn fresh, keeping every message", async () => {
    const { deps, checkpoints } = await homeWithHistory();
    expect(deps.conversations.sessionIdOf(HOME)).toBe("session");

    expect(await startFreshHome(deps, {})).toEqual({ ok: true });
    expect(deps.agents.entry(HOME)?.freshPending).toBe("asked");
    expect(deps.conversations.sessionIdOf(HOME)).toBeUndefined();
    expect(await deps.transcripts.count({ id: HOME })).toBe(ROWS.length);
    expect(checkpoints.kept).toBe(Number.POSITIVE_INFINITY);
});

test("Clear history deletes every message and saved point, and marks the next turn fresh", async () => {
    const { deps, checkpoints } = await homeWithHistory();

    expect(await clearHomeHistory(deps, {})).toEqual({ dropped: ROWS.length });
    expect(await deps.transcripts.count({ id: HOME })).toBe(0);
    expect(checkpoints.kept).toBe(0);
    expect(deps.agents.entry(HOME)?.freshPending).toBe("cleared");
    expect(deps.conversations.sessionIdOf(HOME)).toBeUndefined();
});

test("a home that never ran has nothing to clean up", async () => {
    const deps = routeServices({});
    expect(await startFreshHome(deps, {})).toEqual({ ok: true });
    expect(await clearHomeHistory(deps, {})).toEqual({ dropped: 0 });
});

test("refused while the home is working", async () => {
    const deps = routeServices({});
    const profile = { provider: "claude", harness: "native" } as const;
    await deps.conversations.send(HOME, { kind: "begin", turn: { conversationId: HOME, prompt: "go", isolated: false, profile, home: true } }, 1).settled;
    await expect(startFreshHome(deps, {})).rejects.toThrow("working right now");
    await expect(clearHomeHistory(deps, {})).rejects.toThrow("working right now");
});
