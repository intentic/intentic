import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../../composition.js";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { bookedItemsOf, holdOf, waitingOf } from "../../../../conversations/actor/conversation-queue.js";
import type { TrialStatus } from "../../../../trial/trial.js";
import { TRIAL_RETRY_MAX, retryTrialHolds, trialRetryAt } from "./trial-retry.js";

// PostHog, 2026-11: ten of 31 first messages were turned away by a busy free trial and held for a press, and none of those
// people came back. The resume pass now books those words to go again by themselves, a bounded number of times.

const CONVERSATION = "quiet-heron-abcd";
const NOW = 1_000_000;

const setup = (params: {
    readonly code?: string;
    readonly agent?: string;
    readonly available?: boolean;
    readonly translator?: string;
    readonly status?: Partial<TrialStatus>;
}) => {
    const { conversations } = memoryFleet();
    const refreshed: number[] = [];
    const services = unstubbed<Services>("services", {
        conversations,
        agents: unstubbed<Services["agents"]>("agents", {
            entry: (id: string) =>
                id === CONVERSATION
                    ? unstubbed<NonNullable<ReturnType<Services["agents"]["entry"]>>>("entry", {
                          ending: { kind: "failed", code: params.code ?? "trial-unavailable", failure: "refused" },
                      })
                    : undefined,
        }),
        trial: unstubbed<Services["trial"]>("trial", {
            available: () => params.available ?? true,
            // SAFETY: the rule reads only `retryAt`; the allowance figures are the status poll's own business.
            status: () => params.status as TrialStatus | undefined,
            refresh: async () => {
                refreshed.push(1);
            },
        }),
        config: unstubbed<Services["config"]>("config", { translator: { url: params.translator ?? "http://127.0.0.1:8317", token: "t" } }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {} }),
    });
    const refuse = (): void => {
        conversations.send(CONVERSATION, {
            kind: "queue-returned",
            items: [
                {
                    id: "m-1",
                    voice: "person",
                    queuedAt: 1,
                    turn: { conversationId: CONVERSATION, prompt: "build me a page", agent: params.agent ?? "endpoint/free-trial", harness: "claude-code", model: "auto" },
                },
            ],
        });
    };
    refuse();
    const queue = () => conversations.queued(CONVERSATION);
    // The booked release's own move: the booking let go, the words taken into a turn that the trial refused again.
    const goAndBounce = (): void => {
        conversations.send(CONVERSATION, { kind: "queue-released", ids: ["m-1"] });
        const [item] = queue().items;
        conversations.send(CONVERSATION, { kind: "queue-taken", ids: ["m-1"] });
        if (item !== undefined) {
            conversations.send(CONVERSATION, { kind: "queue-returned", items: [item] });
        }
    };
    return { services, queue, goAndBounce, refreshed };
};

test("books the words the busy trial turned away to go again, on a backoff, and says which try", async () => {
    const { services, queue } = setup({});
    expect(holdOf(queue())).toBe("refused");
    await retryTrialHolds(services, NOW);
    expect(waitingOf(queue())).toEqual([]);
    expect(bookedItemsOf(queue()).map(({ id, until, trialRetry }) => ({ id, until, trialRetry }))).toEqual([
        { id: "m-1", until: NOW + 20_000, trialRetry: { made: 1, max: 3 } },
    ]);
});

test("counts on across refusals and stops after the last try, leaving the words held for a press", async () => {
    const { services, queue, goAndBounce } = setup({});
    const tries: (number | undefined)[] = [];
    for (let pass = 0; pass < TRIAL_RETRY_MAX + 1; pass += 1) {
        await retryTrialHolds(services, NOW);
        const [booked] = bookedItemsOf(queue());
        tries.push(booked?.until === undefined ? undefined : booked.until - NOW);
        if (booked !== undefined) {
            goAndBounce();
        }
    }
    expect(tries).toEqual([20_000, 45_000, 90_000, undefined]);
    expect(holdOf(queue())).toBe("refused");
    expect(waitingOf(queue()).map(({ id, trialRetry }) => ({ id, trialRetry }))).toEqual([{ id: "m-1", trialRetry: { made: 3, max: 3 } }]);
});

test("waits for the platform's own retry instant when it is later, but never past two minutes", () => {
    expect(trialRetryAt(0, NOW, NOW + 50_000)).toBe(NOW + 50_000);
    expect(trialRetryAt(0, NOW, NOW + 600_000)).toBe(NOW + 120_000);
    expect(trialRetryAt(1, NOW, NOW + 5_000)).toBe(NOW + 45_000);
    expect(trialRetryAt(3, NOW, undefined)).toBeUndefined();
});

test("leaves for a press what another try cannot get past: another refusal, words moved off the trial, the trial's route gone", async () => {
    for (const params of [{ code: "trial-model-unavailable" }, { agent: "codex" }, { available: false }, { translator: "" }]) {
        const { services, queue } = setup(params);
        await retryTrialHolds(services, NOW);
        expect(holdOf(queue())).toBe("refused");
        expect(bookedItemsOf(queue())).toEqual([]);
    }
});
