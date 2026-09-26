import type { ChildAgentAsk } from "./requests.js";
import type { TranscriptPermission } from "./transcript.js";
import { childRunOf, repointedChild, sameChildRun } from "./child-run.js";
import { settledRequests } from "../policy/request-status.js";

// A child's run is replaced whole when the owner re-points it on the card: an effort or an account chosen for one model
// means nothing on another, so nothing of the agent's own pick may leak into the owner's.

const asked: ChildAgentAsk = {
    move: "spawn",
    task: "Port the parser to zig",
    provider: "claude",
    model: "claude-opus-4-6",
    effort: "max",
    account: "work",
    on: "rog",
};

describe("sameChildRun", () => {
    test("the provider's own loop is the same run whether it is named or left out", () => {
        expect(sameChildRun({ provider: "claude", model: "m" }, { provider: "claude", model: "m", harness: "native" })).toBe(true);
        expect(sameChildRun({ provider: "claude", model: "m" }, { provider: "claude", model: "m", harness: "claude-code" })).toBe(false);
    });

    test("standard speed is the same run whether it is named or left out", () => {
        expect(sameChildRun({ provider: "claude", model: "m" }, { provider: "claude", model: "m", fast: false })).toBe(true);
    });

    test("naming an effort is a different run from leaving it to the model", () => {
        expect(sameChildRun({ provider: "claude", model: "m" }, { provider: "claude", model: "m", effort: "high" })).toBe(false);
    });
});

describe("repointedChild", () => {
    test("replaces the run whole and keeps what the agent asked for", () => {
        const started = repointedChild(asked, { provider: "codex", model: "gpt-5.5" });
        expect(started).toEqual({
            move: "spawn",
            task: "Port the parser to zig",
            on: "rog",
            provider: "codex",
            model: "gpt-5.5",
            proposed: { provider: "claude", model: "claude-opus-4-6", effort: "max", account: "work" },
        });
    });

    test("leaves the request alone when the owner kept the agent's pick", () => {
        expect(repointedChild(asked, childRunOf(asked))).toBe(asked);
    });
});

describe("a settled child-agent request", () => {
    const card: TranscriptPermission = { requestId: "r1", toolName: "agents.spawn", status: "pending", child: asked };

    test("reads what actually started when the owner re-pointed it", () => {
        const settled = settledRequests(
            { permission: card },
            { kind: "permission", requestId: "r1", decision: "once", child: { provider: "claude", model: "claude-sonnet-4-6" } },
        );
        expect(settled.permission?.status).toBe("allowed");
        expect(settled.permission?.child).toMatchObject({ model: "claude-sonnet-4-6", proposed: { model: "claude-opus-4-6" } });
        expect(settled.permission?.child).not.toHaveProperty("effort");
    });

    test("a no starts nothing, so it keeps what was asked", () => {
        const settled = settledRequests(
            { permission: card },
            { kind: "permission", requestId: "r1", decision: "deny", child: { provider: "claude", model: "claude-sonnet-4-6" } },
        );
        expect(settled.permission?.child).toEqual(asked);
    });

    test("only a start can be re-pointed: a message to a child already running keeps its run", () => {
        const sent: TranscriptPermission = { ...card, child: { ...asked, move: "send", child: "sub-1" } };
        const settled = settledRequests(
            { permission: sent },
            { kind: "permission", requestId: "r1", decision: "once", child: { provider: "codex", model: "gpt-5.5" } },
        );
        expect(settled.permission?.child?.model).toBe("claude-opus-4-6");
    });
});
