import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { collect } from "../../../../harness/route-client.testing.js";
import { codexConnectedProxy, services, withTranslator } from "../../../../harness/route-services.testing.js";
import { recordProviderSuccess } from "../../../providers/provider-health.js";
import { streamAgent } from "../../stream-agent.js";

// A conversation's turn that goes out on another provider than the turn before it says so as its first frame, read off
// the conversation's record on either side of its begin; the turn after it, on the same provider, says nothing.

afterEach(() => {
    // The outage breaker is one clock per provider for the whole process.
    recordProviderSuccess("claude");
    recordProviderSuccess("codex");
});

const answered = async function* (): AsyncGenerator<AgentEvent> {
    yield { kind: "session", sessionId: "s-switch" };
    yield { kind: "delta", text: "on it" };
    yield { kind: "done" };
};

test("a turn on another provider than the one before it opens on the switch, once", async () => {
    // A sandbox of its own, not a runner's mirror, whose parent would tell the switch instead.
    const s = services({
        git: { sync: async () => ({ status: "current" }) },
        agent: answered,
        config: withTranslator,
        cliProxy: codexConnectedProxy,
        codexAgent: answered,
        runnerParent: {},
    });
    const conversationId = "switch-provider";

    const first = await collect(streamAgent(s, { prompt: "start", conversationId }, undefined));
    expect(first.filter((frame) => frame.kind === "switched")).toEqual([]);

    const moved = await collect(streamAgent(s, { prompt: "carry on", conversationId, agent: "codex" }, undefined));
    expect(moved[0]).toStrictEqual({ kind: "switched", segment: "provider", provider: "codex", loop: "Codex", fresh: true });
    expect(moved.filter((frame) => frame.kind === "switched")).toHaveLength(1);

    const stayed = await collect(streamAgent(s, { prompt: "and again", conversationId, agent: "codex" }, undefined));
    expect(stayed.filter((frame) => frame.kind === "switched")).toEqual([]);
});
