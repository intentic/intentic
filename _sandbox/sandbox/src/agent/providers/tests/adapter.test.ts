import { WORKSPACE_ROOT } from "@intentic/constants";
import { armPlan } from "../adapter.js";
import type { AgentRequest, TurnSpec } from "../agent-request.js";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { noIsolation } from "../../../testing.js";
import { rootExecution } from "../../../workload/agent-execution.testing.js";
import { AgentDomainRefusedError, type AgentExecutionContext } from "../../../workload/agent-execution.js";
import { forgetNamespaceEntry, registerMountEntry } from "../../../workload/namespace-entry.js";

// armPlan carries the turn's issued execution capability into every run of its loop, and refuses a replacement spec
// that would move the request to another view. The deadline these tests once shared now lives with the sealed request
// (agent/run/sealed/sealed-deadline.test.ts).

const requestIn = (execution: AgentExecutionContext, spec: TurnSpec = { prompt: "edit the parser", cwd: execution.cwd }): AgentRequest => ({
    execution,
    spec,
    policy: {},
    tools: {},
    credential: { kind: "container" },
    hooks: { cards: unstubbed("cards", {}) },
    signal: new AbortController().signal,
});

const loop = () => jest.fn<(request: AgentRequest) => AsyncGenerator<AgentEvent>>(async function* () { yield { kind: "done" }; });

test("armPlan replaces words and model but retains the exact admitted execution capability", async () => {
    const lease = rootExecution({ localCwd: `${WORKSPACE_ROOT}/project` });
    const original = requestIn(lease.context);
    const runtime = loop();
    const plan = armPlan(runtime, original, "account-1");
    const spec = { ...original.spec, prompt: "approved: edit the parser", model: "model-2", effort: "high" };
    try {
        const frames: AgentEvent[] = [];
        for await (const frame of plan.run(spec)) { frames.push(frame); }
        expect(plan.request).toBe(original);
        expect(plan.request.execution).toBe(lease.context);
        expect(plan.account).toBe("account-1");
        expect(runtime).toHaveBeenCalledTimes(1);
        expect(runtime).toHaveBeenCalledWith({ ...original, spec, execution: lease.context });
        expect(runtime.mock.calls[0]?.[0].execution).toBe(lease.context);
        expect(runtime.mock.calls[0]?.[0].spec).toBe(spec);
        expect(frames).toEqual([{ kind: "done" }]);
    } finally {
        lease.release();
    }
});

test.each(["cwd", "removed isolation", "plan", "anchor"] as const)("armPlan refuses replacement %s before calling the loop", async (changed) => {
    const namespace = registerMountEntry(62101);
    const isolationPlan = await noIsolation(`${WORKSPACE_ROOT}/project`).planFor(`${WORKSPACE_ROOT}/project-tree`, undefined);
    const anchor = { pid: namespace.pid, cwd: `${WORKSPACE_ROOT}/project`, plan: isolationPlan, namespace, dispose: () => {} };
    const isolation = { plan: isolationPlan, anchor };
    const lease = rootExecution({ localCwd: `${WORKSPACE_ROOT}/project-tree`, isolation });
    const original = requestIn(lease.context, { prompt: "edit the parser", cwd: lease.context.cwd, isolation });
    const runtime = loop();
    const armed = armPlan(runtime, original);
    const replacement: TurnSpec = changed === "cwd"
        ? { ...original.spec, cwd: `${WORKSPACE_ROOT}/elsewhere` }
        : changed === "removed isolation"
            ? { prompt: original.spec.prompt, cwd: original.spec.cwd }
            : { ...original.spec, isolation: changed === "plan" ? { ...isolation, plan: { ...isolationPlan } } : { ...isolation, anchor: { ...anchor } } };
    try {
        expect(() => armed.run(replacement)).toThrow(AgentDomainRefusedError);
        expect(() => armed.run(replacement)).toThrow("Agent request placement does not match its admitted execution context.");
        expect(runtime).not.toHaveBeenCalled();
    } finally {
        lease.release();
        forgetNamespaceEntry(namespace);
    }
});

test("armPlan refuses a context released after planning before calling the loop", () => {
    const lease = rootExecution({ localCwd: `${WORKSPACE_ROOT}/project` });
    const original = requestIn(lease.context);
    const runtime = loop();
    const armed = armPlan(runtime, original);
    lease.release();
    expect(() => armed.run(original.spec)).toThrow(AgentDomainRefusedError);
    expect(() => armed.run(original.spec)).toThrow("Agent execution context is not registered or has been released.");
    expect(runtime).not.toHaveBeenCalled();
});

test("armPlan refuses a reconstructed execution capability with matching descriptive fields", () => {
    const lease = rootExecution({ localCwd: `${WORKSPACE_ROOT}/project` });
    const forged = { ...lease.context };
    const original = requestIn(forged);
    const runtime = loop();
    try {
        expect(forged).toEqual(lease.context);
        const armed = armPlan(runtime, original);
        expect(() => armed.run(original.spec)).toThrow(AgentDomainRefusedError);
        expect(() => armed.run(original.spec)).toThrow("Agent execution context is not registered or has been released.");
        expect(runtime).not.toHaveBeenCalled();
    } finally {
        lease.release();
    }
});
