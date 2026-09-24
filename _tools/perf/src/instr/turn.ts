import type { AgentEvent } from "@intentic/sandbox-contract";
import { pick, repoPaths, seeded, words } from "./fixtures.js";

const TOOLS = [
    { name: "Read", category: "read" },
    { name: "Bash", category: "execute" },
    { name: "Edit", category: "edit" },
    { name: "Grep", category: "search" },
] as const;

/**
 * The frames of one long agent turn: `calls` rounds of streamed prose (a delta per few words, as providers chunk it)
 * followed by a tool call that starts, streams output, and settles.
 */
export const agentTurn = (seed: number, calls: number): AgentEvent[] => {
    const next = seeded(seed);
    const paths = repoPaths(seed, 64);
    const events: AgentEvent[] = [];
    for (let call = 0; call < calls; call++) {
        for (let chunk = 0; chunk < 12; chunk++) {
            events.push({ kind: "delta", text: `${words(next, 4)} ` });
        }
        events.push({ kind: "text_end" });
        const tool = pick(next, TOOLS);
        const id = `call-${call}`;
        const path = pick(next, paths);
        events.push({ kind: "tool_call", id, name: tool.name, category: tool.category, status: "in_progress", target: path, locations: [{ path }] });
        events.push({ kind: "tool_call_update", id, content: [{ type: "text", text: words(next, 30) }] });
        events.push({
            kind: "tool_call_update",
            id,
            status: next() < 0.1 ? "failed" : "completed",
            content: [{ type: "text", text: words(next, 60) }],
        });
    }
    events.push({ kind: "delta", text: words(next, 40) });
    return events;
};
