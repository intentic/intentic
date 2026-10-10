import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { privacySliceFake } from "../../../privacy/privacy-slice.testing.js";
import type { TurnArmPlan } from "../../providers/adapter.js";
import type { AgentExecutionLease } from "../../../workload/agent-execution.js";
import { rootExecution } from "../../../workload/agent-execution.testing.js";
import { runSealedRequest, type SealedAsk } from "./sealed-request.js";
import { sealedDeadline } from "./sealed-deadline.js";

// A caller's cancel that lands before the request is under way: one already given when the deadline is made, and one
// given while the privacy shield reads the prompt. Either way nothing answers a caller that has gone.

type Adapter = ReturnType<Services["adapters"]["for"]>;

let lease: AgentExecutionLease;
beforeEach(() => {
    lease = rootExecution({ localCwd: WORKSPACE_ROOT });
});
afterEach(() => {
    lease.release();
});

test("sealedDeadline stops at once for a caller signal that is already aborted", () => {
    const caller = new AbortController();
    caller.abort();
    let stopped = 0;
    const deadline = sealedDeadline(caller.signal, 60_000, () => {
        stopped += 1;
    });
    deadline.release();
    expect(stopped).toBe(1);
});

test("a cancel during the shield's read ends the call: nothing is planned and the call rejects", async () => {
    const caller = new AbortController();
    const seenAborted: boolean[] = [];
    const adapter: Adapter = {
        runtime: "cursor",
        sealed: true,
        preflight: async (_deps, _input, context): Promise<TurnArmPlan> => ({
            ok: true,
            request: { ...context.base, credential: { kind: "cursor-key" as const, apiKey: "key" } },
            account: "cursor-one",
            run: async function* (): AsyncGenerator<AgentEvent> {
                seenAborted.push(context.base.signal.aborted);
                yield { kind: "delta", text: "fix: answered after the cancel" };
                yield { kind: "done" };
            },
        }),
        health: unstubbed<Adapter>("adapter", {}).health,
        holdsSession: unstubbed<Adapter>("adapter", {}).holdsSession,
    };
    const privacy = privacySliceFake({});
    const services = unstubbed<Services>("services", {
        // The owner closes the panel while the shield is still reading the prompt.
        privacyShield: unstubbed<Services["privacyShield"]>("privacyShield", {
            seal: async (request) => {
                caller.abort();
                return { prompt: request.prompt, restore: (text: string) => text };
            },
        }),
        adapters: { for: () => adapter, all: [adapter] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
        cards: unstubbed<Services["cards"]>("cards", {}),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { clear: async () => {} }),
        claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { clear: async () => {} }),
        modelCooldowns: unstubbed<Services["modelCooldowns"]>("modelCooldowns", { clear: async () => {} }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
    });
    void privacy;
    const ask: SealedAsk = {
        execution: lease.context,
        provider: "cursor",
        harness: "claude-code",
        model: "composer-2.5",
        prompt: "Write a commit subject.",
        signal: caller.signal,
    };
    const outcome = await runSealedRequest(services, ask).then(
        (value) => `resolved: ${value}`,
        () => "rejected",
    );
    expect(seenAborted).toEqual([]);
    expect(outcome).toBe("rejected");
});
