import { WORKSPACE_ROOT } from "@intentic/constants";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { privacySliceFake } from "../../../privacy/privacy-slice.testing.js";
import { armPlan, type TurnArmPlan } from "../../providers/adapter.js";
import type { AgentExecutionLease } from "../../../workload/agent-execution.js";
import { rootExecution } from "../../../workload/agent-execution.testing.js";
import { runAgent } from "../harness/claude-code-runner.js";
import type { QueryFn } from "../harness/claude-code-stream.js";
import { parkedCards } from "../../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { runSealedRequest, type SealedAsk } from "./sealed-request.js";
import { SETTLES, waitFor } from "@intentic/testing/bun";

// A sealed request on the real Claude Code loop (runAgent) whose provider defers its retry past the helper's patience.
// Closing runAgent's frames waits for its pump, which ends only once the SDK is aborted, so the attempt must be stopped
// before its frames are closed: the refusal is said at once, as the provider's, rather than as the deadline 20s later.

jest.mock("../../prompt/preset-prompt.js", () => ({
    presetSystemPrompt: async () => ({ text: "preset", version: "2.1.0" }),
}));

const actors = memoryFleet().conversations;
const cards = parkedCards(actors);

type Adapter = ReturnType<Services["adapters"]["for"]>;

let lease: AgentExecutionLease;
beforeEach(() => {
    lease = rootExecution({ localCwd: WORKSPACE_ROOT });
});
afterEach(() => {
    lease.release();
});

const build = () => {
    const seen: { sdkAbortedAt?: number; retryAt?: number } = {};
    // The SDK as runAgent drives it: an api_retry deferred 60s, then nothing until its abortController aborts.
    const query: QueryFn = async function* (args) {
        yield { type: "system", subtype: "init", session_id: "s-1", model: "claude-haiku-4-5" } as unknown as SDKMessage;
        seen.retryAt = Date.now();
        yield {
            type: "system",
            subtype: "api_retry",
            session_id: "s-1",
            attempt: 1,
            max_retries: 10,
            retry_delay_ms: 60_000,
            error_status: 529,
            error: "server_error",
        } as unknown as SDKMessage;
        const signal = args.options?.abortController?.signal;
        await new Promise<void>((resolve) => {
            if (signal === undefined || signal.aborted) {
                resolve();
                return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        seen.sdkAbortedAt = Date.now();
    };
    const adapter: Adapter = {
        runtime: "claude-code",
        sealed: true,
        preflight: async (_deps, _input, context): Promise<TurnArmPlan> =>
            armPlan((request) => runAgent(actors, request, query), { ...context.base, credential: { kind: "container" as const } }),
        health: unstubbed<Adapter>("adapter", {}).health,
        holdsSession: unstubbed<Adapter>("adapter", {}).holdsSession,
    };
    const privacy = privacySliceFake({});
    const services = unstubbed<Services>("services", {
        privacyShield: privacy.privacyShield,
        adapters: { for: () => adapter, all: [adapter] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
        cards,
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {}, info: () => {}, debug: () => {} }),
    });
    const caller = new AbortController();
    const ask: SealedAsk = {
        execution: lease.context,
        provider: "claude",
        harness: "claude-code",
        model: "claude-haiku-4-5",
        prompt: "Write a commit subject.",
        signal: caller.signal,
    };
    return { seen, services, caller, ask };
};

test("left alone on a fake clock, the deferred retry is said long before the deadline, and as the retry", async () => {
    const { seen, services, caller, ask } = build();
    jest.useFakeTimers();
    try {
        const pending = runSealedRequest(services, ask).then(
            () => "resolved",
            (error: unknown) => (error as Error).message,
        );
        let outcome: string | undefined;
        void pending.then((value) => {
            outcome = value;
        });
        // The loop prepares asynchronously; no deadline or retry timer advances while it prepares and refuses.
        await waitFor(() => expect(outcome).toBe("the model did not answer (retry deferred 60s)"), SETTLES);
        expect(seen.retryAt).toEqual(expect.any(Number));
        expect(seen.sdkAbortedAt).toEqual(expect.any(Number));
    } finally {
        caller.abort();
        jest.useRealTimers();
    }
});
