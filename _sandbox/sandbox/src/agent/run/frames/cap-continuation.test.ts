import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { pino } from "pino";
import type { Services } from "../../../composition.js";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { createDomainEvents } from "../../../seams/domain-events.js";
import type { RoutedTurn, StartedRun, TurnInput } from "../../../seams/turn-starter.js";
import { expiredFrame, turnWatchdog } from "../../../runtimes/decorators/turn-watchdog.js";
import { capContinuationClause, continueCappedTurn, MAX_CAP_CONTINUATIONS } from "./cap-continuation.js";

// A vendor loop's turn that reached its hard cap while it was still sending events carries on by itself in a fresh turn
// of the same session once it has settled, at most MAX_CAP_CONTINUATIONS times in a row (2026-11-02: five such caps in
// four OpenCode conversations waited on the owner's "Continue", up to 40 minutes each).

const fleet = memoryFleet();

const servicesFor = () => {
    const started: TurnInput[] = [];
    let runs = 0;
    const events = createDomainEvents(() => {});
    const services = {
        agents: fleet.agents,
        conversations: fleet.conversations,
        events,
        logger: pino({ level: "silent" }),
        turns: unstubbed<Services["turns"]>("turns", {
            start: async (turn: TurnInput): Promise<StartedRun> => {
                started.push(turn);
                runs += 1;
                return unstubbed<StartedRun>("run", { id: `run-next-${String(runs)}` });
            },
        }),
    };
    return { services, started, events };
};

// The frame a vendor loop ends a capped turn with, as the watchdog words it: a cap of zero is already reached.
const capFrame = (active: boolean) => {
    const clock = turnWatchdog({ inactivityMs: 3_600_000, maxTurnMs: 0 });
    if (!active) {
        // Past the still-active window: a turn that had gone quiet before its cap came.
        const realNow = Date.now;
        Date.now = () => realNow() + 120_000;
        try {
            return expiredFrame(clock, (why) => `Google turn on the OpenCode loop timed out: ${why}.`);
        } finally {
            Date.now = realNow;
        }
    }
    return expiredFrame(clock, (why) => `Google turn on the OpenCode loop timed out: ${why}.`);
};

const turnOf = (conversationId: string): RoutedTurn => ({ conversationId, prompt: "Unify the dialog menus", agent: "opencode", harness: "native" });

const settle = (events: ReturnType<typeof createDomainEvents>, conversationId: string, run: string): void =>
    events.publish("run.settled", { conversationId, run, actor: undefined, speaker: undefined, failure: "turn-cap", closing: "" });

test("a turn capped while still working says it carries on, and does in the same session once it has settled", async () => {
    const { services, started, events } = servicesFor();
    const frame = capFrame(true);
    expect(frame.code).toBe("turn-cap");

    const told = continueCappedTurn(services, frame, { input: turnOf("conv-cap"), run: "run-1" });

    expect(told.message).toBe(`${frame.message} ${capContinuationClause(1)}`);
    expect(told.message).toContain(`carries on by itself in a fresh turn of the same session (1 of ${String(MAX_CAP_CONTINUATIONS)} in a row)`);
    // Nothing goes before the capped run has settled.
    expect(started).toEqual([]);
    settle(events, "conv-cap", "run-other");
    expect(started).toEqual([]);
    settle(events, "conv-cap", "run-1");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ conversationId: "conv-cap", resume: "continued", speaker: { kind: "sandbox", source: "turn-cap" } });
});

test("the chain counts on through its own continuations and hands the next move to the owner past the bound", async () => {
    const { services, started, events } = servicesFor();
    let run = "run-1";
    for (let count = 1; count <= MAX_CAP_CONTINUATIONS; count += 1) {
        const told = continueCappedTurn(services, capFrame(true), { input: turnOf("conv-chain"), run });
        expect(told.message).toContain(`(${String(count)} of ${String(MAX_CAP_CONTINUATIONS)} in a row)`);
        settle(events, "conv-chain", run);
        await waitFor(() => expect(started).toHaveLength(count));
        run = `run-next-${String(count)}`;
    }
    const last = continueCappedTurn(services, capFrame(true), { input: turnOf("conv-chain"), run });
    expect(last.message).toContain(`has already carried on by itself ${String(MAX_CAP_CONTINUATIONS)} times in a row, so the next move is yours`);
    settle(events, "conv-chain", run);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toHaveLength(MAX_CAP_CONTINUATIONS);
});

test("a cap reached after the loop went quiet, and any other failure, are left for the owner", () => {
    const { services } = servicesFor();
    const quiet = capFrame(false);
    expect(quiet.message).toContain("the loop having sent nothing for the last");
    expect(continueCappedTurn(services, quiet, { input: turnOf("conv-quiet"), run: "run-1" })).toBe(quiet);
    const outage = { kind: "error" as const, code: "provider-outage" as const, message: "upstream gone", own: true };
    expect(continueCappedTurn(services, outage, { input: turnOf("conv-quiet"), run: "run-1" })).toBe(outage);
});
