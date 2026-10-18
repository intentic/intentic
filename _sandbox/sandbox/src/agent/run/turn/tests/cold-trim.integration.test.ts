import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { experimentArm } from "@intentic/agent-context/experiments";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { TRIM_KEEPS_RESULTS } from "@intentic/sandbox-contract/schemas/providers/handoff";
import type { Services } from "../../../../composition.js";
import { conversationEntry } from "../../../../conversations/registry/agents-store.testing.js";
import { services as routeServices, recordingTurnStores } from "../../../../harness/route-services.testing.js";
import { collect } from "../../../../harness/route-client.testing.js";
import { streamAgent } from "../../stream-agent.js";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { coldTrimTurn } from "../cold-trim.js";

let store: string;
beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), "cold-trim-"));
    await mkdir(join(store, "projects", "project"), { recursive: true });
});
afterEach(async () => {
    await rm(store, { recursive: true, force: true });
});
const path = () => join(store, "projects", "project", "session.jsonl");
const transcript = () => {
    const entries: Record<string, unknown>[] = [];
    let parentUuid: string | null = null;
    const append = (entry: Record<string, unknown>) => {
        const uuid = `u${entries.length}`;
        entries.push({ uuid, parentUuid, sessionId: "session", ...entry });
        parentUuid = uuid;
    };
    for (let i = 0; i < TRIM_KEEPS_RESULTS + 2; i++) {
        append({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/file${i}` } }] } });
        append({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "file content" }] } });
    }
    append({ type: "user", message: { content: "Preserve this unanswered instruction" } });
    return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
};
const services = () =>
    unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", { entry: () => conversationEntry({ sessionId: "session" }) }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { sessionStore: () => store }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
    });
const basis = { contextTokens: 150_000, promptCache: { at: 1, ttlMs: 300_000 } };
const input = (arm: boolean) => ({
    prompt: "continue",
    agent: "claude" as const,
    sessionId: "session",
    conversationId: Array.from({ length: 100 }, (_, i) => `cold-${i}`).find((id) => experimentArm("cold-trim", id, 0.5) === arm)!,
});

test.each([true, false])("cold eligible arm %s stamps assignment and resumes the appropriate session", async (arm) => {
    const original = transcript();
    await writeFile(path(), original);
    const result = await coldTrimTurn(services(), input(arm), SandboxSettingsSchema.parse({}), false, basis);
    expect(result?.stamps).toEqual(arm ? { coldTrimArm: true, coldTrimmed: 2 } : { coldTrimArm: false });
    if (arm) {
        expect(result?.turn.sessionId).not.toBe("session");
        const copy = await readFile(join(store, "projects", "project", `${result?.turn.sessionId}.jsonl`), "utf8");
        expect(copy).toContain("Preserve this unanswered instruction");
        expect(result && "event" in result ? result.event : undefined).toMatchObject({ mode: "trim", cleared: 2, from: 150_000 });
    } else {
        expect(result?.turn.sessionId).toBe("session");
    }
    expect(await readFile(path(), "utf8")).toBe(original);
});

test("compacted sessions and held turns do not enter either arm", async () => {
    await writeFile(path(), `${transcript() + JSON.stringify({ type: "system", subtype: "compact_boundary" })}\n`);
    expect(await coldTrimTurn(services(), input(true), SandboxSettingsSchema.parse({}), false, basis)).toBeUndefined();
    await writeFile(path(), transcript());
    expect(await coldTrimTurn(services(), input(true), SandboxSettingsSchema.parse({}), true, basis)).toBeUndefined();
    expect(await coldTrimTurn(services(), input(true), SandboxSettingsSchema.parse({}), false, undefined)).toBeUndefined();
});

test("the streamed follow-up retains the pre-begin cache clock, discloses the trim and files its stamps", async () => {
    await writeFile(path(), transcript());
    const turn = input(true);
    const recorded = recordingTurnStores();
    let resumed: string | undefined;
    const deps = routeServices({
        ...recorded.overrides,
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { sessionStore: () => store }),
        async *agent(request): AsyncGenerator<AgentEvent> {
            resumed = request.spec.sessionId;
            yield { kind: "session", sessionId: resumed ?? "new" };
            yield { kind: "delta", text: "Done." };
            yield { kind: "usage", inputTokens: 10, outputTokens: 10, costUsd: 0, numTurns: 1, durationMs: 1 };
            yield { kind: "done" };
        },
    });
    await deps.conversations.send(
        turn.conversationId,
        {
            kind: "begin",
            turn: { conversationId: turn.conversationId, prompt: "earlier", isolated: false, profile: { provider: "claude", harness: "native" } },
        },
        1,
    ).settled;
    deps.conversations.send(turn.conversationId, { kind: "frame", frame: { kind: "session", sessionId: "session" } }, 2);
    deps.conversations.send(
        turn.conversationId,
        { kind: "frame", frame: { kind: "context_usage", tokens: 150_000, contextWindow: 200_000, cachedAt: 1, cacheTtlMs: 300_000 } },
        3,
    );
    await deps.conversations.send(turn.conversationId, { kind: "settle" }, 4).settled;
    const frames = await collect(streamAgent(deps, turn, undefined));
    expect(frames.find((frame) => frame.kind === "handoff")).toMatchObject({ kind: "handoff", mode: "trim", cleared: 2, from: 150_000 });
    expect(resumed).toEqual(expect.any(String));
    expect(resumed).not.toBe("session");
    expect(recorded.writes.usage.at(-1)).toMatchObject({ coldTrimArm: true, coldTrimmed: 2 });
});
