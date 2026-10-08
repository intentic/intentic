import { type AgentDomainPolicy, AgentDomainPolicySchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { collect } from "../../harness/route-client.testing.js";
import type { TurnInput } from "../../seams/turn-starter.js";
import { streamAgent } from "../../agent/run/stream-agent.js";
import { AGENT_DOMAIN_NOT_READY, requireAgentDomainRollout } from "./agent-domain-rollout.js";
import { createAgentExecutionService } from "../agent-execution.js";

// No real processes: only the protected reader and its real coordinator are usable; other services throw if reached.
const policyServices = (get: () => Promise<AgentDomainPolicy>): Services => unstubbed<Services>("services", {
    agentDomainPolicy: unstubbed<Services["agentDomainPolicy"]>("agentDomainPolicy", { get }),
    agentExecution: createAgentExecutionService(get),
});

test("absent-policy defaults remain root; incomplete unprivileged mode refuses", () => {
    expect(() => requireAgentDomainRollout(AgentDomainPolicySchema.parse({}))).not.toThrow();
    expect(() => requireAgentDomainRollout({ agentDomain: "unprivileged" })).toThrow(AGENT_DOMAIN_NOT_READY);
});

const turns: readonly TurnInput[] = [
    { prompt: "go" },
    { prompt: "go", conversationId: "existing" },
    { prompt: "go", conversationId: "worktree", isolated: true },
    { prompt: "go", conversationId: "remote", placement: { kind: "runner", id: "paired-runner" } },
];

test.each(turns.map((turn) => [turn] as const))("unprivileged policy refuses before any helper or placement: %j", async (turn) => {
    const services = policyServices(async () => ({ agentDomain: "unprivileged" }));
    expect(await collect(streamAgent(services, turn, undefined))).toStrictEqual([
        { kind: "error", code: "agent-domain-refused", message: AGENT_DOMAIN_NOT_READY },
        { kind: "done" },
    ]);
});

test("unreadable policy refuses instead of using the root default", async () => {
    const services = policyServices(async () => { throw new Error("protected policy is corrupt"); });
    expect(await collect(streamAgent(services, { prompt: "go" }, undefined))).toStrictEqual([
        { kind: "error", code: "agent-domain-refused", message: "protected policy is corrupt" },
        { kind: "done" },
    ]);
});

test("root admission continues to normal runner validation", async () => {
    const services = policyServices(async () => ({ agentDomain: "root" }));
    expect(await collect(streamAgent(services, { prompt: "go", placement: { kind: "runner", id: "runner" } }, undefined))).toStrictEqual([
        { kind: "error", message: "Running on a runner needs a conversation id — the conversation's branch is what travels." },
        { kind: "done" },
    ]);
});
