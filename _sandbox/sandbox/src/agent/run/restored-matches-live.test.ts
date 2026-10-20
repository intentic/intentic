import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { foldTurn, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { type HarnessRequest, runAgent } from "./agent.js";
import type { QueryFn } from "./sdk-stream.js";
import { restoredSessionMessages } from "../../sessions/sessions.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";

// Stands in for the installed CLI's preset, so a turn here never spawns one to read it.
jest.mock("../prompt/preset-prompt.js", () => ({
    presetSystemPrompt: async () => ({ text: "For actions that are hard to reverse, confirm first.", version: "2.1.0" }),
}));

// ONE TURN, TWO READINGS, ONE TRANSCRIPT. The same Claude turn is read live (the CLI's stream: each prose and thought
// block streamed as deltas between its start and stop, then the whole message) and read back from the provider's own
// store (the whole messages alone). Both become rows through the one fold, so a thought, a run of calls and a card land
// in the same bubbles either way, and a reopened chat is grouped as the live one was (2026-10: rows grouped one way live
// and another after a reload, from a second reducer that copied the fold's bubble rules by hand).

const actors = memoryFleet().conversations;
const cards = parkedCards(actors);

type Block =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "thinking"; readonly thinking: string }
    | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown };
type Stored = { readonly type: "assistant"; readonly message: { readonly content: Block[] } } | { readonly type: "user"; readonly message: { readonly content: unknown } };

const said = (...content: Block[]): Stored => ({ type: "assistant", message: { content } });
const answered = (id: string, content: string, failed = false): Stored => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: failed }] },
});

// What the CLI streams for one stored assistant message: each prose or thought block as its start, its delta and its
// stop, then the message whole (which is where the live stream reads its calls).
const streamed = (message: Stored): unknown[] => {
    if (message.type === "user") {
        return [message];
    }
    const events = message.message.content.flatMap((block, index) => {
        if (block.type === "tool_use") {
            return [];
        }
        const delta = block.type === "text" ? { type: "text_delta", text: block.text } : { type: "thinking_delta", thinking: block.thinking };
        return [
            { type: "content_block_start", index, content_block: { type: block.type } },
            { type: "content_block_delta", index, delta },
            { type: "content_block_stop", index },
        ].map((event) => ({ type: "stream_event", event }));
    });
    return [...events, { ...message, session_id: "5e551011-0000" }];
};

const PROMPT = "tidy the config";

const liveRows = async (stored: readonly Stored[]): Promise<TranscriptRow[]> => {
    const messages = [...stored.flatMap(streamed), { type: "result", subtype: "success" }];
    const query: QueryFn = async function* () {
        for (const message of messages) {
            // SAFETY: each message is built above in the CLI's own wire shape (streamed), which is all the stream reads.
            yield message as SDKMessage;
        }
    };
    const request: HarnessRequest = {
        execution: unstubbed("execution", {}),
        spec: { prompt: PROMPT, cwd: WORKSPACE_ROOT },
        policy: {},
        tools: {},
        credential: { kind: "container" },
        hooks: { cards },
        signal: new AbortController().signal,
    };
    const frames: AgentEvent[] = [];
    for await (const event of runAgent(actors, request, query)) {
        frames.push(event);
    }
    return foldTurn([userRow(PROMPT, 0, [])], frames).slice(1);
};

const restoredRows = (stored: readonly Stored[]): TranscriptRow[] =>
    restoredSessionMessages([{ type: "user", message: { content: PROMPT } }, ...stored], WORKSPACE_ROOT).slice(1);

const TURNS = {
    "a thought, prose, then calls whose results come back one message later": [
        said({ type: "thinking", thinking: "look first" }),
        said({ type: "text", text: "Reading the config." }),
        said({ type: "tool_use", id: "r1", name: "Read", input: { file_path: `${WORKSPACE_ROOT}/app/config.ts` } }),
        said({ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }),
        answered("r1", "export const port = 1;"),
        answered("b1", "boom", true),
        said({ type: "text", text: "Done." }),
    ],
    "thoughts between calls stay in the run they interleave": [
        said({ type: "thinking", thinking: "one" }),
        said({ type: "tool_use", id: "b1", name: "Bash", input: { command: "echo 1" } }),
        answered("b1", "1"),
        said({ type: "thinking", thinking: "two" }),
        said({ type: "tool_use", id: "b2", name: "Bash", input: { command: "echo 2" } }),
        answered("b2", "2"),
        said({ type: "text", text: "Both ran." }),
    ],
    "an edit keeps its call-time diff, an MCP call keeps its input, and a call cut off stays running": [
        said({ type: "tool_use", id: "e1", name: "Edit", input: { file_path: `${WORKSPACE_ROOT}/a.ts`, old_string: "a", new_string: "b" } }),
        answered("e1", "The file has been updated."),
        said({ type: "tool_use", id: "m1", name: "mcp__code__run", input: { code: "console.log(1)" } }),
        answered("m1", "1"),
        said({ type: "text", text: "Now the tests." }),
        said({ type: "tool_use", id: "b1", name: "Bash", input: { command: "pnpm test" } }),
    ],
    "the checklist rides the bubble its verbs were said in, and raises no card": [
        said({ type: "text", text: "Planning." }, { type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "Step 1", activeForm: "Doing step 1" } }),
        answered("c1", "Task #1 created successfully: Step 1"),
        said({ type: "tool_use", id: "u1", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } }),
        said({ type: "tool_use", id: "r1", name: "Read", input: { file_path: `${WORKSPACE_ROOT}/b.ts` } }),
        answered("r1", "ok"),
    ],
} satisfies Record<string, readonly Stored[]>;

describe("a turn read back from the provider's store", () => {
    for (const [name, stored] of Object.entries(TURNS)) {
        it(`is grouped as it was drawn live: ${name}`, async () => {
            const restored = restoredRows(stored);
            expect(restored.length).toBeGreaterThan(0);
            expect(restored).toEqual(await liveRows(stored));
        });
    }
});
