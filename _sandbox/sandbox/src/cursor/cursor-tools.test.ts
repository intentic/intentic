import type { AgentEvent } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { openSpawnedChild, resetSubagents, settleSpawnedChild, type SubagentTurn } from "../agent/subagents.js";
import type { AgentRequest } from "../agent/agent.js";
import type { ChildSupervisor } from "../children/children.js";
import { cursorCustomTools } from "./cursor-tools.js";

/* Which daemon tools a Cursor turn is handed, and what the pair actually does. The mount rules are the
 * suite's spine: `ask` follows attendance (a card an unattended turn cannot answer is a deadlock), the
 * spawn/wait pair follows the ENGINE's presence (planCursorTurn sets it under the full-agency predicate), and
 * neither implies the other. */

const request = (over: Partial<AgentRequest> = {}): AgentRequest =>
    ({
        prompt: "do the thing",
        cwd: "/work",
        conversationId: "conv-cursor",
        signal: new AbortController().signal,
        ...over,
    }) as AgentRequest;

const push = (): ((event: AgentEvent) => void) => () => {};

const supervisor = (over: Partial<ChildSupervisor> = {}): ChildSupervisor => ({
    spawn: async () => ({ ok: true, id: "sub-x" }),
    send: async () => ({ ok: true }),
    answer: () => ({ ok: true }),
    pendingQuestion: () => undefined,
    ...over,
});

describe("which tools mount", () => {
    it("an attended turn with no engine gets the ask alone", () => {
        expect(Object.keys(cursorCustomTools(request(), push()))).toEqual(["ask"]);
    });

    it("an unattended turn with no engine gets nothing", () => {
        expect(Object.keys(cursorCustomTools(request({ unattended: true }), push()))).toEqual([]);
    });

    it("the engine brings the supervision set, and unattended keeps it: a child deadlocks nothing", () => {
        const children = supervisor();
        expect(Object.keys(cursorCustomTools(request({ children }), push()))).toEqual(["ask", "spawn", "wait", "send", "answer"]);
        expect(Object.keys(cursorCustomTools(request({ children, unattended: true }), push()))).toEqual(["spawn", "wait", "send", "answer"]);
    });
});

describe("what the pair does", () => {
    it("spawn relays the spec and answers with the child's id and the wait to follow it with", async () => {
        const specs: unknown[] = [];
        const children = supervisor({
            spawn: async (spec) => {
                specs.push(spec);
                return { ok: true, id: "sub-brave-otter-a1b2" };
            },
        });
        const tools = cursorCustomTools(request({ children }), push());
        const answer = JSON.parse(
            (await tools["spawn"]?.execute?.({ prompt: "port the parser", provider: "cursor", model: "composer-2.5" }, {} as never)) as string,
        ) as { ok: boolean; child: string; note: string };
        expect(specs).toEqual([{ prompt: "port the parser", provider: "cursor", model: "composer-2.5" }]);
        expect(answer.ok).toBe(true);
        expect(answer.child).toBe("sub-brave-otter-a1b2");
        expect(answer.note).toContain("wait");
    });

    it("spawn without a prompt refuses without calling the engine", async () => {
        let called = 0;
        const children = supervisor({
            spawn: async () => {
                called += 1;
                return { ok: true, id: "sub-x" };
            },
        });
        const tools = cursorCustomTools(request({ children }), push());
        const answer = JSON.parse((await tools["spawn"]?.execute?.({}, {} as never)) as string) as { ok: boolean };
        expect(answer.ok).toBe(false);
        expect(called).toBe(0);
    });

    it("wait parks on the same roster the harness tool reads, and returns the settled child", async () => {
        resetSubagents();
        const turn: SubagentTurn = { conversationId: "conv-cursor", cwd: "/work", sessionId: undefined, subagentsDir: undefined };
        openSpawnedChild(turn, { id: "sub-child-1", description: "port it", provider: "claude" });
        const tools = cursorCustomTools(request({ children: supervisor() }), push());
        const parked = tools["wait"]?.execute?.({ target: "sub-child-1", timeoutSeconds: 5 }, {} as never) as Promise<string>;
        settleSpawnedChild("sub-child-1", { failed: false, report: "done: two files changed" });
        const answer = JSON.parse(await parked) as { outcome: string; agent?: { summary?: string } };
        expect(answer.outcome).toBe("finished");
        expect(answer.agent?.summary).toBe("done: two files changed");
    });
});
