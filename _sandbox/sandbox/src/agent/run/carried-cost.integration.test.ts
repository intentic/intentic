import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { type HarnessRequest, runAgent } from "./agent.js";
import { CHUNK_BYTES, carriedCostOf, TAIL_LIMIT_BYTES } from "./carried-cost.js";
import type { QueryFn } from "./sdk-stream.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";

// Stands in for the installed CLI's preset, so a turn here never spawns one to read it.
jest.mock("../prompt/preset-prompt.js", () => ({
    presetSystemPrompt: async () => ({ text: "For actions that are hard to reverse, confirm first.", version: "2.1.0" }),
}));

// A resumed Claude session's first result already counts the spend its transcript saved; the baseline read here is what
// keeps a usage frame to that result's own spend. Integration suite: reads real transcripts on disk.

const SESSION = "6e296ad0-8660-428e-aa79-b014a3c61004";

const costState = (totalCostUSD: number, sessionId: string = SESSION): string =>
    JSON.stringify({ type: "cost-state", sessionId, totalCostUSD, modelUsage: {} });
const message = (text: string): string => JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: text } });

// Kilobyte lines, at least `bytes` of them in all, standing for whatever a session wrote after its last saved total.
const filler = (bytes: number): string[] =>
    Array.from({ length: Math.ceil(bytes / 1_024) }, (_, index) => message(String(index).padStart(1_024, "x")));

// A session store holding one transcript, filed where the CLI files it: under the sanitized cwd it ran in.
const storeWith = (lines: readonly string[], project = "-work"): string => {
    const store = mkdtempSync(join(tmpdir(), "carried-cost-"));
    mkdirSync(join(store, "projects", project), { recursive: true });
    writeFileSync(join(store, "projects", project, `${SESSION}.jsonl`), `${lines.join("\n")}\n`);
    return store;
};

describe("the baseline a resumed session carries", () => {
    test("is the last total the session saved, whichever project directory holds it", async () => {
        const store = storeWith([message("hi"), costState(1.5), message("more"), costState(4.25), message("after")], "-work--intentic-tmp-demo");
        expect(await carriedCostOf({ sessionId: SESSION, sessionStore: store })).toBe(4.25);
    });

    test("skips another session's total and a record that is not one", async () => {
        const store = storeWith([costState(2), costState(9, "0f0f0f0f-other-session"), '{"type":"cost-state","sessionId":"broken"', message("tail")]);
        expect(await carriedCostOf({ sessionId: SESSION, sessionStore: store })).toBe(2);
    });

    test("is nothing for a fresh turn, a store without the transcript, or one that saved no total", async () => {
        const store = storeWith([message("never finished")]);
        expect(await carriedCostOf({ sessionStore: store })).toBe(0);
        expect(await carriedCostOf({ sessionId: SESSION })).toBe(0);
        expect(await carriedCostOf({ sessionId: "5d1c0e9a-no-transcript", sessionStore: store })).toBe(0);
        expect(await carriedCostOf({ sessionId: SESSION, sessionStore: store })).toBe(0);
        expect(await carriedCostOf({ sessionId: "../escape", sessionStore: store })).toBe(0);
    });

    // The first read starts 20 bytes before the record's line break: one line after it, sized to land the boundary there.
    test("reads a record the first chunk's boundary cut in two", async () => {
        const after = message("z".repeat(CHUNK_BYTES - 22 - message("").length));
        const store = storeWith([message("earlier"), costState(0.75), after]);
        expect(await carriedCostOf({ sessionId: SESSION, sessionStore: store })).toBe(0.75);
    });

    // A crash leaves no record at the end, so the one the CLI restores sits under everything written since.
    test("reaches back past the first chunks for an older total", async () => {
        const store = storeWith([costState(0.5), ...filler(3 * CHUNK_BYTES)]);
        expect(await carriedCostOf({ sessionId: SESSION, sessionStore: store })).toBe(0.5);
    });

    // Past the tail the read gives up rather than parse a whole transcript; the cost is one overcounted result.
    test("stops at the tail limit", async () => {
        const store = storeWith([costState(3), ...filler(TAIL_LIMIT_BYTES + CHUNK_BYTES)]);
        expect(await carriedCostOf({ sessionId: SESSION, sessionStore: store })).toBe(0);
    });
});

const fakeQuery = (...messages: unknown[]): QueryFn =>
    async function* () {
        for (const sdkMessage of messages) {
            yield sdkMessage as SDKMessage;
        }
    };

// One fleet's actors, and the cards a turn here parks in them.
const actors = memoryFleet().conversations;
const cards = parkedCards(actors);

const resumedTurn = async (sessionStore: string, queryFn: QueryFn): Promise<AgentEvent[]> => {
    const request: HarnessRequest = {
        spec: { prompt: "carry on", cwd: WORKSPACE_ROOT, sessionStore, sessionId: SESSION },
        policy: {},
        tools: {},
        credential: { kind: "container" },
        hooks: { cards },
        signal: new AbortController().signal,
    };
    const events: AgentEvent[] = [];
    for await (const event of runAgent(actors, request, queryFn)) {
        events.push(event);
    }
    return events;
};

test("a resumed turn's usage frame is its own spend, not the total the session carried in", async () => {
    const store = storeWith([message("earlier"), costState(1.5)]);
    const events = await resumedTurn(
        store,
        fakeQuery({ type: "result", subtype: "success", session_id: SESSION, total_cost_usd: 1.75, modelUsage: {} }),
    );
    expect(events.filter((event) => event.kind === "usage")).toEqual([{ kind: "usage", costUsd: 0.25 }]);
});
