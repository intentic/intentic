import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { withTextBoundaries } from "./text-boundaries.js";
import { toolCard } from "../../../runtimes/decorators/vendor-events.js";

// Every loop's prose blocks closed where the model moves on, and every loop's tool cards built one way.

async function* frames(...events: AgentEvent[]): AsyncGenerator<AgentEvent> {
    yield* events;
}

const drain = async (stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
    const out: AgentEvent[] = [];
    for await (const event of stream) {
        out.push(event);
    }
    return out;
};

const call = (id: string, parentToolUseId?: string): AgentEvent => toolCard({ id, name: "Bash", parentToolUseId });

test("a block a loop left open is closed by the call that follows it, in its own thread only", async () => {
    const out = await drain(
        withTextBoundaries(
            frames(
                { kind: "delta", text: "Looking." },
                { kind: "delta", text: "In the child.", parentToolUseId: "task-1" },
                call("c1"),
                { kind: "delta", text: "Done." },
                { kind: "done" },
            ),
        ),
    );
    expect(out).toEqual([
        { kind: "delta", text: "Looking." },
        { kind: "delta", text: "In the child.", parentToolUseId: "task-1" },
        { kind: "text_end" },
        call("c1"),
        { kind: "delta", text: "Done." },
        { kind: "done" },
    ]);
});

test("a block its loop closed itself is not closed twice, and a child's call closes the child's block", async () => {
    const out = await drain(
        withTextBoundaries(
            frames({ kind: "delta", text: "a" }, { kind: "text_end" }, call("c1"), { kind: "delta", text: "b", parentToolUseId: "task-1" }, call("c2", "task-1")),
        ),
    );
    expect(out.filter((event) => event.kind === "text_end")).toEqual([{ kind: "text_end" }, { kind: "text_end", parentToolUseId: "task-1" }]);
});

test("a card is categorized by the canonical name, shown by its display name, and keeps the arguments no target says", () => {
    expect(toolCard({ id: "b1", name: "mcp__browser__browser_navigate", input: { account: "x", url: "https://x.com/home" } })).toMatchObject({
        name: "Browser navigate",
        category: "fetch",
        target: "https://x.com/home",
    });
    expect(toolCard({ id: "m1", name: "mcp__accounts__roster", input: { account: "x" } })).toMatchObject({ category: "other", input: '{"account":"x"}' });
    expect(toolCard({ id: "r1", name: "Read", input: { file_path: "/w/src/a.ts" }, cwd: "/w" })).toMatchObject({
        category: "read",
        target: "/w/src/a.ts",
        locations: [{ path: "src/a.ts" }],
    });
});
