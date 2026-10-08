import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Loop } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { readRoleAnswer, type RoleAsk } from "../agent/models/role-answer.js";
import {
    AgentDomainRefusedError, assertAgentExecutionContext, createAgentExecutionService,
    type AgentExecutionContext, type AgentExecutionService,
} from "../workload/agent-execution.js";
import { rootExecutionService } from "../workload/agent-execution.testing.js";
import type { StopVerdict } from "./loop-stop.js";

const ask = jest.fn<(prompt: string, signal: AbortSignal) => Promise<string>>();
const modelSet = jest.fn<() => boolean>(() => true);
const executions: AgentExecutionContext[] = [];
const roles: string[] = [];
jest.mock("../agent/models/role-model.js", () => ({
    askRoleModel: async (_services: Services, execution: AgentExecutionContext, role: string, request: RoleAsk<StopVerdict>, signal: AbortSignal) => {
        assertAgentExecutionContext(execution);
        executions.push(execution);
        roles.push(role);
        const prompt = typeof request.prompt === "string" ? request.prompt : request.prompt(4_000);
        return { value: readRoleAnswer(request.answer, await ask(prompt, signal)) };
    },
    roleModelIsSet: async () => modelSet(),
}));
const { evaluateStop } = await import("./loop-stop.js");

// No output document and judge-only checks: neither filesystem reads nor command execution belong in this suite.
const loop = (checks: Loop["checks"] = [{ kind: "judge", rubric: "The suite passes with proof." }]): Loop => ({
    conversationId: "loop-1", goal: "The suite passes.", prompt: "Fix the top failure.", context: "fresh",
    output: { kind: "none" }, checks, maxIterations: 3, stallLimit: 99, isolated: false,
});
const services = (execution: AgentExecutionService = rootExecutionService()): Services =>
    unstubbed<Services>("services", {
        agentExecution: execution,
        workspace: unstubbed<Services["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
    });
const params = () => ({ iteration: 1, cwd: `${WORKSPACE_ROOT}/private-loop`, report: "Fixed the failure; the focused test passed.", signal: new AbortController().signal });

beforeEach(() => {
    ask.mockReset();
    modelSet.mockReturnValue(true);
    executions.length = 0;
    roles.length = 0;
});

test("an iteration with no checks needs no independent execution", async () => {
    const service = rootExecutionService();
    const admit = jest.spyOn(service, "admit");
    expect(await evaluateStop(services(service), loop([]), params())).toEqual({ done: true });
    expect(admit).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
});

test.each([false, true])("owns and releases independent verdict execution when the model fails=%s", async (fails) => {
    const service = rootExecutionService();
    const admit = jest.spyOn(service, "admit");
    const acquire = jest.spyOn(service, "acquire");
    const close = jest.spyOn(service, "close");
    const input = params();
    if (fails) { ask.mockRejectedValue(new Error("verdict unavailable")); }
    else { ask.mockResolvedValue("DONE The focused test passed."); }

    expect(await evaluateStop(services(service), loop(), input)).toEqual(fails
        ? { done: false, detail: "Judge did not run: verdict unavailable" }
        : { done: true });

    expect(roles).toEqual(["loop-verdict"]);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("The suite passes with proof."), input.signal);
    expect(ask.mock.calls[0]?.[0]).toContain(input.report);
    expect(executions).toHaveLength(1);
    // The finished iteration's cwd is not a live lease; the independent helper names its explicit local placement.
    expect(executions[0]?.cwd).toBe("/work");
    expect(() => assertAgentExecutionContext(executions[0]!)).toThrow(AgentDomainRefusedError);
    const admission = acquire.mock.calls[0]![0];
    expect(admit).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith(admission, { localCwd: "/work" });
    expect(close).toHaveBeenCalledWith(admission);
    expect(() => service.acquire(admission, { localCwd: "/work" })).toThrow(AgentDomainRefusedError);
});

test("a CONTINUE verdict short-circuits the remaining judges", async () => {
    ask.mockResolvedValue("CONTINUE Verification is still missing.");
    expect(await evaluateStop(services(), loop([
        { kind: "judge", rubric: "Show verification." }, { kind: "judge", rubric: "Do not ask this judge yet." },
    ]), params())).toEqual({ done: false, detail: "CONTINUE Verification is still missing." });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(executions).toHaveLength(1);
});

test("an unset verdict role stays not-done without admitting unplaced execution", async () => {
    const readProtectedPolicy = async () => ({ agentDomain: "unprivileged" as const });
    const service = createAgentExecutionService(readProtectedPolicy, () => undefined);
    const admit = jest.spyOn(service, "admit");
    modelSet.mockReturnValue(false);
    expect(await evaluateStop(services(service), loop(), params())).toEqual({
        done: false,
        detail: "Judge did not run: No model is set for this job, so it does not run. Set one in Sandbox ▸ Agent ▸ Models.",
    });
    expect(admit).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
});

test("an unplaced unprivileged verdict refuses instead of reporting an unavailable judge", async () => {
    const readProtectedPolicy = async () => ({ agentDomain: "unprivileged" as const });
    const service = createAgentExecutionService(readProtectedPolicy, () => undefined);
    const close = jest.spyOn(service, "close");
    await expect(evaluateStop(services(service), loop(), params())).rejects.toBeInstanceOf(AgentDomainRefusedError);
    expect(ask).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
});

test("domain refusal from a verdict model propagates unchanged and releases its execution", async () => {
    const refusal = new AgentDomainRefusedError("verdict context was released");
    ask.mockRejectedValue(refusal);
    await expect(evaluateStop(services(), loop(), params())).rejects.toBe(refusal);
    expect(() => assertAgentExecutionContext(executions[0]!)).toThrow(AgentDomainRefusedError);
});
