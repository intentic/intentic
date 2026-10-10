import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { capabilitiesOf } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { ANCHOR_READY, type IsolationPlan, startMountAnchor } from "../../conversations/worktrees/isolation.js";
import { AgentDomainRefusedError, createAgentExecutionService } from "../../workload/agent-execution.js";
import type { HarnessRequest } from "../../agent/run/agent.js";
import type { RoutedTurn } from "../../seams/turn-starter.js";
import { keepableOf } from "../../agent/run/turn/cache-keepwarm.js";
import { claudeWarm } from "./claude-warm.js";

// A root-mode isolated Claude turn whose mount-namespace anchor ends mid-turn (an agent running `pkill sleep` as root
// reaches it: the anchor is `sleep infinity` in the daemon's own PID namespace) still reaches its `finally`, where it is
// asked what it leaves to keep its cache by before it is settled. Claude's own answer is a refusal (the execution no
// longer stands), which keepableOf takes as "nothing to keep": a throw there would skip the settlement (usage ledger,
// completion row, reach, snapshot) and report a root-mode turn as "agent-domain-refused".
const plan: IsolationPlan = { root: "/view", worktree: "/local", mirrors: [], overlays: "/overlays", fence: undefined };

const fakeHolder = (pid: number) => {
    const child = Object.assign(new EventEmitter(), {
        pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
        stdout: new PassThrough(), stderr: new PassThrough(),
        unref: () => undefined,
        kill: () => true,
        stopSetup: () => undefined,
    });
    const start = () => {
        queueMicrotask(() => { child.stdout.write(`${ANCHOR_READY}\n`); });
        return child;
    };
    return { child, start, exit: () => { child.exitCode = null; child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM"); } };
};

test("root mode: an anchor that died mid-turn leaves nothing to keep, rather than a refusal thrown where the turn is settled", async () => {
    expect(capabilitiesOf("claude", "claude-code").warm).toBe(true);
    const holder = fakeHolder(63_901);
    const anchor = await startMountAnchor(plan, holder.start);
    const service = createAgentExecutionService(async () => ({ agentDomain: "root" }));
    const admission = await service.admit();
    const lease = service.acquire(admission, { localCwd: plan.worktree, isolation: { plan, anchor } });
    const request: HarnessRequest = {
        execution: lease.context,
        spec: { cwd: anchor.cwd, prompt: "words", model: "m", isolation: { plan, anchor } },
        policy: {}, tools: {}, hooks: { cards: unstubbed("cards", {}) },
        credential: { kind: "claude-oauth", token: "synthetic" }, signal: new AbortController().signal,
    };
    // The holder ends while the turn's lease is still live (the turn has not reached runTurn's finally yet).
    holder.child.exitCode = null;
    holder.exit();
    const warned: unknown[] = [];
    const deps = unstubbed<Parameters<typeof keepableOf>[0]>("deps", {
        providerModules: [{ id: "claude", warm: claudeWarm }] as never,
        logger: unstubbed("logger", { warn: (fields: { err?: unknown }) => void warned.push(fields.err) }),
    });
    // Claude's own answer is still the refusal: the execution's placement is gone.
    expect(() => claudeWarm.keepable(deps as never, { request, account: "acct", sessionId: "sess", anchor: undefined as never })).toThrow(AgentDomainRefusedError);
    // What the settling turn hears is "nothing to keep", said in the log.
    const keepable = keepableOf(deps, {
        input: { agent: "claude", harness: "claude-code" } as RoutedTurn,
        request,
        account: "acct",
        sessionId: "sess",
        fingerprint: undefined,
        spawned: false,
    });
    expect(keepable).toBeUndefined();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toBeInstanceOf(AgentDomainRefusedError);
    lease.release();
    service.close(admission);
});
