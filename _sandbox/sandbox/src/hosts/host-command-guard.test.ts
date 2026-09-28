import { DEFAULT_SAFETY_POLICY, type SafetyLogEntry, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { startTurnRun } from "../agent/run/turn/turn-runs.js";
import type { Services } from "../composition.js";
import { turnRunOf } from "../conversations/actor/conversation-holdings.js";
import { parkedCards } from "../conversations/actor/parked-cards.js";
import { clearTurnTaint, NO_TAINT, publishTurnTaint } from "../guard/turn-taint.js";
import { createDomainEvents } from "../seams/domain-events.js";
import { memoryFleet } from "../testing.js";
import { judgeHostCommand } from "./host-command-guard.js";

// What the agent reads back from a device command its owner was asked about, for each way the card can end. The judge
// is off, so what raises the card is the device hard rule alone: `rm -rf` on somebody's own machine.

const MACHINE = "rog";
const CONVERSATION = "conv-device";
const ASKED = { machine: MACHINE, command: "rm -rf ~/old-builds", conversationId: CONVERSATION };

const fleet = memoryFleet();
const cards = parkedCards(fleet.conversations);

// What the gate wrote onto the safety log entry its card left, once the card settled.
const answers: { readonly answer: SafetyLogEntry["answer"]; readonly outcome: SafetyLogEntry["outcome"] }[] = [];

const services = unstubbed<Services>("services", {
    conversations: fleet.conversations,
    cards,
    events: createDomainEvents(() => {}),
    safetyPolicy: unstubbed<Services["safetyPolicy"]>("safetyPolicy", { text: async () => DEFAULT_SAFETY_POLICY }),
    // Off: no model is asked, so the hard rule alone decides that the owner is.
    sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
        get: async () => ({ ...SandboxSettingsSchema.parse({}), commandJudge: "off" as const }),
    }),
    safetyLog: unstubbed<Services["safetyLog"]>("safetyLog", {
        record: async () => {},
        answered: async (_at, answer, outcome) => {
            answers.push({ answer, outcome });
        },
    }),
    logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
});

// The conversation's turn, held open by the real pump until the test ends it, and attended, so there is someone to ask.
let endTurn = (): void => {};
const liveTurn = (): void => {
    const held = new Promise<void>((resolve) => {
        endTurn = resolve;
    });
    startTurnRun(
        { conversations: fleet.conversations, events: createDomainEvents(() => {}) },
        // Says nothing until the test ends the turn, then ends it the way a runtime does.
        async function* pump() {
            await held;
            yield { kind: "done" } as const;
        },
        { conversationId: CONVERSATION, prompt: "tidy the laptop" },
    );
    publishTurnTaint(CONVERSATION, NO_TAINT);
};

// The card the gate raised on the turn, once it is up: what an answer is addressed by.
const cardUp = async (): Promise<string> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const card = turnRunOf(fleet.conversations, CONVERSATION)
            ?.rows.map((row) => row.permission)
            .find((permission) => permission?.status === "pending");
        if (card !== undefined) {
            return card.requestId;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("the gate raised no card on the turn");
};

// Handed out in place of the card's real ten-minute timer, so a test can let the deadline pass.
let deadline = new AbortController();
const armDeadline = () => jest.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
let timeout: ReturnType<typeof armDeadline> | undefined;

beforeEach(() => {
    answers.length = 0;
    deadline = new AbortController();
    timeout = armDeadline();
    liveTurn();
});

afterEach(async () => {
    endTurn();
    await turnRunOf(fleet.conversations, CONVERSATION)?.waitUntilFinished();
    clearTurnTaint(CONVERSATION);
    timeout?.mockRestore();
});

describe("nobody answers the card", () => {
    it("says so, and what to do next, when the deadline passes with the turn still running", async () => {
        const judged = judgeHostCommand(services, ASKED);
        await cardUp();
        deadline.abort();

        expect(await judged).toEqual({
            refusal:
                'Nobody answered within 10 minutes, so it was not run on "rog". Do not retry it unasked: carry on without it and say what was left undone.',
        });
        // The one timer the card set, ten minutes long.
        expect(timeout?.mock.calls).toEqual([[600_000]]);
        // Read by an agent still working: the turn goes on.
        expect(turnRunOf(fleet.conversations, CONVERSATION)?.done).toBe(false);
        expect(answers).toEqual([{ answer: "unanswered", outcome: "refused" }]);
    });

    it("settles the card when the turn ends, and says the turn ended rather than that time ran out", async () => {
        const judged = judgeHostCommand(services, ASKED);
        const requestId = await cardUp();
        endTurn();

        expect(await judged).toEqual({ refusal: 'The turn ended before anyone answered, so it was not run on "rog". Do not retry it unasked.' });
        expect(deadline.signal.aborted).toBe(false);
        expect(answers).toEqual([{ answer: "unanswered", outcome: "refused" }]);
        // Gone from the registry, so a press after the turn ended cannot send the command to the machine.
        expect(cards.resolve({ kind: "permission", requestId, decision: "once" })).toBe("missing");
    });
});

describe("somebody answers the card", () => {
    it("hands the agent the owner's own words when they decline this one call and let the turn go on", async () => {
        const judged = judgeHostCommand(services, ASKED);
        const requestId = await cardUp();
        expect(cards.resolve({ kind: "permission", requestId, decision: "deny", feedback: "Keep the builds; clear the cache instead." })).toBe(
            "settled",
        );

        expect(await judged).toEqual({ refusal: "Keep the builds; clear the cache instead." });
        expect(answers).toEqual([{ answer: "declined", outcome: "refused" }]);
    });

    it("tells the agent not to look for a way around a bare decline", async () => {
        const judged = judgeHostCommand(services, ASKED);
        expect(cards.resolve({ kind: "permission", requestId: await cardUp(), decision: "deny" })).toBe("settled");

        expect(await judged).toEqual({
            refusal: 'The user declined this. Do not run it on "rog", and do not look for another way to achieve the same thing.',
        });
        expect(answers).toEqual([{ answer: "declined", outcome: "refused" }]);
    });

    it("forwards the command to the machine once the owner allows it", async () => {
        const judged = judgeHostCommand(services, ASKED);
        expect(cards.resolve({ kind: "permission", requestId: await cardUp(), decision: "once" })).toBe("settled");

        expect(await judged).toBeUndefined();
        expect(answers).toEqual([{ answer: "allowed", outcome: "allowed" }]);
    });
});
