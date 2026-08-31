import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { ConversationWorktree } from "../agents/worktrees.js";
import type { Services } from "../composition.js";
import { dispatchRemoteTurn } from "./runner-dispatch.js";

/* The dispatch's OFFLINE answer, the one path that needs no runner to exist: a machine asleep is a normal
 * state, and the frame the user reads must say what to do about it — never a spinner, never a turn that
 * quietly runs here instead (the placement was the user's explicit ask). */

const worktree: ConversationWorktree = { cwd: "/nowhere", branch: "agent/c1", repos: [{ repo: "root", base: "abc" }] };

test("an offline runner is a readable error frame and a closed turn, not a hang", async () => {
    const services = { runnerHub: { client: () => undefined } } as unknown as Services;
    const frames: AgentEvent[] = [];
    for await (const event of dispatchRemoteTurn(
        services,
        { conversationId: "c1", prompt: "do the thing", placement: { kind: "runner", id: "rog" } },
        "rog",
        worktree,
        undefined,
    )) {
        frames.push(event);
    }
    expect(frames.map((frame) => frame.kind)).toEqual(["error", "done"]);
    const error = frames[0];
    const message = error?.kind === "error" ? error.message : "";
    expect(message).toContain("rog");
    expect(message).toMatch(/offline/i);
});
