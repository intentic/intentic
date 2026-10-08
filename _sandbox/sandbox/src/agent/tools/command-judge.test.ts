import { WORKSPACE_ROOT } from "@intentic/constants";
import { readRoleAnswer, UnusableAnswerError } from "../models/role-answer.js";
import type { Services } from "../../composition.js";
import { unstubbed } from "@intentic/testing";
import { AgentDomainRefusedError, assertAgentExecutionContext, createAgentExecutionService, type AgentExecutionContext, type AgentExecutionLease } from "../../workload/agent-execution.js";
import { RoleModelUnsetError } from "../../seams/role-model-unset.js";
import { rootExecutionService } from "../../workload/agent-execution.testing.js";

const asked = jest.fn<() => Promise<{ value: { verdict: { decision: "allow"; sentence: string }; recognised: boolean } }>>();
const executions: AgentExecutionContext[] = [];
jest.mock("../models/role-model.js", () => ({
    askRoleModel: (_services: Services, execution: AgentExecutionContext) => {
        assertAgentExecutionContext(execution);
        executions.push(execution);
        return asked();
    },
}));
const { judgeAnswer, judgeCommand, judgeIndependentCommand } = await import("./command-judge.js");
const JUDGE_INPUT: Parameters<typeof judgeCommand>[2] = {
    policy: "Allow searches.", program: "rg title src", pins: [{ provider: "claude", model: "haiku" }],
    facts: { consequences: [], language: "bash", unattended: false },
};
beforeEach(() => {
    executions.length = 0;
    asked.mockReset();
});

// Routed through readRoleAnswer, not judgeAnswer.read directly: the contract is the pair, an unwrapped value and the
// usability check over it.
const verdict = (reply: string) => readRoleAnswer(judgeAnswer, reply).verdict;

test("reads the three decisions and the sentence", () => {
    expect(verdict(`DECISION: allow\nWHY: Runs the test suite.`)).toEqual({ decision: `allow`, sentence: `Runs the test suite.` });
    expect(verdict(`DECISION: refuse\nWHY: Publishes to npm.`)).toEqual({ decision: `refuse`, sentence: `Publishes to npm.` });
});

test("carries the proposed policy line when the judge offered one", () => {
    expect(verdict(`DECISION: ask\nWHY: Deletes the build directory.\nPOLICY: Deleting build output is fine.`)).toEqual({
        decision: `ask`,
        sentence: `Deletes the build directory.`,
        policyLine: `Deleting build output is fine.`,
    });
});

// Each of these is a right answer in wrong packaging, worth a rung to strip; refusing it would re-ask a correct
// verdict.
test("survives the wrappers a model adds on its own", () => {
    expect(verdict("```\nDECISION: allow\nWHY: Lists the directory.\n```")).toMatchObject({ decision: `allow`, sentence: `Lists the directory.` });
    expect(verdict(`decision: ALLOW\nwhy: "Lists the directory."`)).toMatchObject({ decision: `allow`, sentence: `Lists the directory.` });
    // A model that qualifies the word has still answered; holding that against it spends a rung on punctuation.
    expect(verdict(`DECISION: ask (the owner)\nWHY: Force-pushes to origin.`)).toMatchObject({ decision: `ask` });
});

// An unreadable reply is never permission: defaulting to allow would make garbling the reply an attack, since a garbled
// reply is what a confused or coerced model produces.
test("a reply with no recognisable decision is unusable, not an allow", () => {
    for (const reply of [
        `I think this is probably fine to run.`,
        `DECISION: maybe\nWHY: Hard to say.`,
        `WHY: Deletes the build directory.`,
        `DECISION:\nWHY: Deletes the build directory.`,
    ]) {
        expect(() => verdict(reply), reply).toThrow(UnusableAnswerError);
    }
});

test("a decision with no sentence is unusable: the sentence is the reason for every verdict", () => {
    expect(() => verdict(`DECISION: ask`)).toThrow(UnusableAnswerError);
});

// A paragraph is not a sentence; past this length the reply reads as a forbidden stage-by-stage walkthrough rather than
// a verdict's reason.
test("a walkthrough where a sentence was asked for is unusable", () => {
    expect(() => verdict(`DECISION: ask\nWHY: ${`word `.repeat(60)}`)).toThrow(UnusableAnswerError);
});

// A provider's own quota or limit message must never read as a verdict; role-answer.ts catches it ahead of this
// contract.
test("a provider's refusal is a refusal, not a ruling", () => {
    expect(() => verdict(`You have exceeded your current quota.`)).toThrow();
});

test("passes the caller's authentic execution to the judge and preserves a domain refusal", async () => {
    const service = rootExecutionService();
    const services = unstubbed<Services>("services", { agentExecution: service });
    const admission = await service.admit();
    const lease = service.acquire(admission, { localCwd: WORKSPACE_ROOT });
    const input = JUDGE_INPUT;
    const signal = new AbortController().signal;
    asked.mockResolvedValue({ value: { verdict: { decision: "allow", sentence: "Searches source files." }, recognised: true } });
    try {
        expect(await judgeCommand(services, lease.context, input, signal)).toEqual({ decision: "allow", sentence: "Searches source files." });
        expect(executions).toEqual([lease.context]);
        expect(executions[0]).toBe(lease.context);
        // The judge borrows the turn's authority, not its lifetime: the caller still owns this lease.
        assertAgentExecutionContext(lease.context);
        const refusal = new AgentDomainRefusedError("judge context was released");
        asked.mockRejectedValue(refusal);
        await expect(judgeCommand(services, lease.context, input, signal)).rejects.toBe(refusal);
        expect(executions).toEqual([lease.context, lease.context]);
        expect(executions[1]).toBe(lease.context);
    } finally {
        lease.release();
        service.close(admission);
    }
});

test.each(["returned", "rejected", "refused"])("independent host judge closes its authentic execution when the model %s", async (outcome) => {
    const service = rootExecutionService();
    const acquireLease = service.acquire;
    const leases: AgentExecutionLease[] = [];
    const admit = jest.spyOn(service, "admit");
    const close = jest.spyOn(service, "close");
    const acquire = jest.spyOn(service, "acquire").mockImplementation((admission, placement) => {
        const lease = acquireLease(admission, placement);
        const tracked = { context: lease.context, release: jest.fn(lease.release) };
        leases.push(tracked);
        return tracked;
    });
    const services = unstubbed<Services>("services", {
        agentExecution: service,
        workspace: unstubbed<Services["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
    });
    const failure = outcome === "refused" ? new AgentDomainRefusedError("host judge context was released") : new Error("host judge unavailable");
    if (outcome === "returned") {
        asked.mockResolvedValue({ value: { verdict: { decision: "allow", sentence: "Searches source files." }, recognised: true } });
    } else { asked.mockRejectedValue(failure); }

    const judging = judgeIndependentCommand(services, JUDGE_INPUT, new AbortController().signal);
    if (outcome === "returned") { await expect(judging).resolves.toEqual({ decision: "allow", sentence: "Searches source files." }); }
    else { await expect(judging).rejects.toBe(failure); }

    expect(admit).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    const admission = acquire.mock.calls[0]![0];
    expect(acquire).toHaveBeenCalledWith(admission, { localCwd: "/work" });
    expect(executions).toHaveLength(1);
    expect(executions[0]).toBe(leases[0]!.context);
    expect(leases[0]!.release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(admission);
    expect(() => assertAgentExecutionContext(executions[0]!)).toThrow(AgentDomainRefusedError);
    expect(() => acquireLease(admission, { localCwd: "/work" })).toThrow(AgentDomainRefusedError);
});

test("an independent host judge that is unset never admits or acquires execution", async () => {
    const service = rootExecutionService();
    const admit = jest.spyOn(service, "admit");
    const acquire = jest.spyOn(service, "acquire");
    const services = unstubbed<Services>("services", { agentExecution: service });
    await expect(judgeIndependentCommand(services, { ...JUDGE_INPUT, pins: [] }, new AbortController().signal)).rejects.toBeInstanceOf(RoleModelUnsetError);
    expect(admit).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
});

test("an unplaced unprivileged host judge refuses before asking a model and closes admission", async () => {
    const readProtectedPolicy = async () => ({ agentDomain: "unprivileged" as const });
    const service = createAgentExecutionService(readProtectedPolicy, () => undefined);
    const admit = jest.spyOn(service, "admit");
    const acquire = jest.spyOn(service, "acquire");
    const close = jest.spyOn(service, "close");
    const services = unstubbed<Services>("services", {
        agentExecution: service,
        workspace: unstubbed<Services["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
    });
    await expect(judgeIndependentCommand(services, JUDGE_INPUT, new AbortController().signal)).rejects.toBeInstanceOf(AgentDomainRefusedError);
    expect(admit).toHaveBeenCalledTimes(1);
    const admission = acquire.mock.calls[0]![0];
    expect(acquire).toHaveBeenCalledWith(admission, { localCwd: "/work" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(admission);
    expect(() => service.acquire(admission, { localCwd: "/work" })).toThrow("Agent execution admission is not registered or has been closed.");
    expect(asked).not.toHaveBeenCalled();
    expect(executions).toEqual([]);
});
