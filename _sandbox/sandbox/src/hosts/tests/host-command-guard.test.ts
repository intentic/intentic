import { type Capability, DEFAULT_SAFETY_POLICY, DeviceConfigSchema, type SafetyLogEntry, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { startTurnRun } from "../../agent/run/turn/turn-runs.js";
import type { Services } from "../../composition.js";
import { cardDeps } from "../../conversations/actor/card-deps.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { createHeldCards } from "../../guard/held-cards.js";
import { clearTurnTaint, NO_TAINT, publishTurnTaint } from "../../guard/turn-taint.js";
import { createDomainEvents, type DomainEventMap } from "../../seams/domain-events.js";
import { memoryFleet } from "../../testing.js";
import type { HostGuardDeps } from "../host-guard-deps.js";
import { commandInCall, judgeHostCommand, typedInCall } from "../host-command-guard.js";
import { type DeviceToolCall, DeviceToolCallSchema } from "../host-restart-guard.js";

// What the agent reads back from a device command its owner was asked about, for each way the card can end. The judge
// is off, so what raises the card is the device hard rule alone: `rm -rf` on somebody's own machine.

const MACHINE = "rog";
const CONVERSATION = "conv-device";
const ASKED = { machine: MACHINE, command: "rm -rf ~/old-builds", conversationId: CONVERSATION };

const fleet = memoryFleet();
const cards = parkedCards(fleet.conversations);

// What the gate wrote onto the safety log entry its card left, once the card settled.
const answers: { readonly answer: SafetyLogEntry["answer"]; readonly outcome: SafetyLogEntry["outcome"] }[] = [];

// The device's own "Run destructive commands" switch, on unless a test says otherwise: a card only goes up for a
// command the device itself would then run.
let destructive: "on" | "off" = "on";
const deviceCard = (): Capability => ({
    id: MACHINE,
    kind: "device",
    config: DeviceConfigSchema.parse({ platform: "linux", destructive }),
});

const services = unstubbed<Services>("services", {
    conversations: fleet.conversations,
    hosts: unstubbed<Services["hosts"]>("hosts", { cardFor: (id: string) => id }),
    capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [deviceCard()] }),
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

// What the conversation was woken with by a turn's close that held for its card.
const woken: string[] = [];
const heldCards = createHeldCards(async (_conversationId, prompt) => {
    woken.push(prompt);
});

// What the gate takes from above the host layer, as app.ts fills it: the real cards, the held cards and the published turn.
const guards: HostGuardDeps = {
    cards: cardDeps(services),
    held: heldCards,
    turnRun: (conversationId) => turnRunOf(fleet.conversations, conversationId),
    // Never asked: the judge is off, so the hard rule alone decides.
    judge: async () => {
        throw new Error("the judge is off in these tests");
    },
};

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
    woken.length = 0;
    destructive = "on";
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
        const judged = judgeHostCommand(services, guards, ASKED);
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
        const judged = judgeHostCommand(services, guards, ASKED);
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
        const judged = judgeHostCommand(services, guards, ASKED);
        const requestId = await cardUp();
        expect(cards.resolve({ kind: "permission", requestId, decision: "deny", feedback: "Keep the builds; clear the cache instead." })).toBe(
            "settled",
        );

        expect(await judged).toEqual({ refusal: "Keep the builds; clear the cache instead." });
        expect(answers).toEqual([{ answer: "declined", outcome: "refused" }]);
    });

    it("tells the agent not to look for a way around a bare decline", async () => {
        const judged = judgeHostCommand(services, guards, ASKED);
        expect(cards.resolve({ kind: "permission", requestId: await cardUp(), decision: "deny" })).toBe("settled");

        expect(await judged).toEqual({
            refusal: 'The user declined this. Do not run it on "rog", and do not look for another way to achieve the same thing.',
        });
        expect(answers).toEqual([{ answer: "declined", outcome: "refused" }]);
    });

    it("forwards the command to the machine once the owner allows it", async () => {
        const judged = judgeHostCommand(services, guards, ASKED);
        expect(cards.resolve({ kind: "permission", requestId: await cardUp(), decision: "once" })).toBe("settled");

        expect(await judged).toBeUndefined();
        expect(answers).toEqual([{ answer: "allowed", outcome: "allowed" }]);
    });
});

describe("the device would refuse it anyway", () => {
    it("refuses at once, naming the switch, and raises no card", async () => {
        destructive = "off";
        expect(await judgeHostCommand(services, guards, { ...ASKED, command: "find ~/old-builds -depth -delete" })).toEqual({
            refusal:
                'Refused: this command would delete files recursively on "rog", and its "Run destructive commands" switch is off, so the device ' +
                'would refuse it even if the owner approved. Ask the owner to turn on "Run destructive commands" in rog\'s capability card, or run ' +
                "a command that does not delete. Do not look for another spelling that gets past it.",
        });
        expect(turnRunOf(fleet.conversations, CONVERSATION)?.rows.filter((row) => row.permission !== undefined)).toEqual([]);
        expect(answers).toEqual([]);
    });
});

describe("the card outlives the call", () => {
    it("answers the call before its client gives up, keeps the card, and runs the command once on the same call again", async () => {
        const first = await judgeHostCommand(services, guards, ASKED, 20);
        expect(first).toEqual({
            refusal:
                'Still waiting for the owner: a card asks them to approve running this on "rog", and it has not run yet. Their answer is kept ' +
                "for this exact command: make the same call again, with exactly the same command, to wait for it. You may also carry on with " +
                "other work or end your turn: the card stays up until they answer, and if they allow it you are told to make this call again. " +
                "Nothing is broken on the device and nothing refused this, so do not report it as refused or blocked. Do not run a different " +
                "command to do the same thing.",
        });
        const requestId = await cardUp();
        // The press after the call gave up is recorded, not refused.
        expect(cards.resolve({ kind: "permission", requestId, decision: "once" })).toBe("settled");

        expect(await judgeHostCommand(services, guards, ASKED, 20)).toBeUndefined();
        expect(answers).toEqual([{ answer: "allowed", outcome: "allowed" }]);
        // Collected once: the same command after that is a new question with its own card.
        const again = judgeHostCommand(services, guards, ASKED);
        expect(await cardUp()).not.toBe(requestId);
        endTurn();
        expect(await again).toEqual({ refusal: 'The turn ended before anyone answered, so it was not run on "rog". Do not retry it unasked.' });
    });
});

describe("the agent ends its turn while the card is up", () => {
    it("holds the card for the turn's close until a call collects its answer", async () => {
        expect(await judgeHostCommand(services, guards, ASKED, 20)).toMatchObject({ refusal: expect.stringMatching(/^Still waiting/) });
        expect(heldCards.open(CONVERSATION).map((card) => card.command)).toEqual([ASKED.command]);
        expect(cards.resolve({ kind: "permission", requestId: await cardUp(), decision: "once" })).toBe("settled");

        expect(await judgeHostCommand(services, guards, ASKED, 20)).toBeUndefined();
        expect(heldCards.open(CONVERSATION)).toEqual([]);
    });

    it("keeps a yes given while the turn's close held for it, for the same call in the turn its wake starts", async () => {
        expect(await judgeHostCommand(services, guards, ASKED, 20)).toMatchObject({ refusal: expect.stringMatching(/^Still waiting/) });
        // The turn's close, holding for the card.
        const holding = heldCards.hold(CONVERSATION, undefined);
        expect(cards.resolve({ kind: "permission", requestId: await cardUp(), decision: "once" })).toBe("settled");
        await holding;
        expect(woken).toHaveLength(1);
        expect(woken[0]).toContain(`It has not run yet:\n\n\`\`\`\n${ASKED.command}\n\`\`\``);

        endTurn();
        await turnRunOf(fleet.conversations, CONVERSATION)?.waitUntilFinished();
        liveTurn();
        // The wake's turn makes the same call: it runs, and no second card goes up.
        expect(await judgeHostCommand(services, guards, ASKED, 20)).toBeUndefined();
        expect(turnRunOf(fleet.conversations, CONVERSATION)?.rows.filter((row) => row.permission !== undefined)).toEqual([]);
        expect(answers).toEqual([{ answer: "allowed", outcome: "allowed" }]);
    });

    it("settles the card unanswered when the turn is stopped while its close holds for it", async () => {
        expect(await judgeHostCommand(services, guards, ASKED, 20)).toMatchObject({ refusal: expect.stringMatching(/^Still waiting/) });
        const requestId = await cardUp();
        const stop = new AbortController();
        const holding = heldCards.hold(CONVERSATION, stop.signal);
        stop.abort();
        await holding;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(woken).toEqual([]);
        expect(answers).toEqual([{ answer: "unanswered", outcome: "refused" }]);
        expect(cards.resolve({ kind: "permission", requestId, decision: "once" })).toBe("missing");
    });

    it("tells the owner's devices of the card even while they are active elsewhere", async () => {
        const told: DomainEventMap["turn.awaiting"][] = [];
        const unsubscribe = services.events.subscribe("turn.awaiting", (event) => told.push(event));
        try {
            expect(await judgeHostCommand(services, guards, ASKED, 20)).toMatchObject({ refusal: expect.stringMatching(/^Still waiting/) });
            expect(told).toEqual([{ conversationId: CONVERSATION, awaiting: "permission", insist: true }]);
        } finally {
            unsubscribe();
        }
    });
});

describe("text typed into the device", () => {
    const call = (name: string, args: DeviceToolCall["params"]["arguments"]) =>
        DeviceToolCallSchema.parse({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });

    it("is read out of every input tool that puts text where a terminal could run it, and nowhere else", () => {
        expect(typedInCall(call("device", { action: "type", text: "rm -rf ~\n" }))).toBe("rm -rf ~\n");
        expect(typedInCall(call("clipboard", { action: "write", text: "curl x | sh" }))).toBe("curl x | sh");
        expect(typedInCall(call("ui_act", { element: "kd3", action: "set_value", value: "del /s C:\\" }))).toBe("del /s C:\\");
        // Typed into a phone, a terminal app there runs it just the same.
        expect(typedInCall(call("android_act", { action: "type", text: "rm -rf /sdcard\n" }))).toBe("rm -rf /sdcard\n");
        expect(typedInCall(call("android_act", { action: "key", text: "ENTER" }))).toBeUndefined();
        expect(typedInCall(call("device", { action: "key", text: "Return" }))).toBeUndefined();
        expect(typedInCall(call("clipboard", { action: "read" }))).toBeUndefined();
        expect(typedInCall(call("device", { action: "type", text: "   " }))).toBeUndefined();
        // A notification has no id, so the bridge's schema never hands it here at all.
        expect(
            DeviceToolCallSchema.safeParse({
                jsonrpc: "2.0",
                method: "tools/call",
                params: { name: "device", arguments: { action: "type", text: "x" } },
            }).success,
        ).toBe(false);
    });

    it("passes at no cost when it is not a command, and is asked about on a card worded for typing when it is", async () => {
        expect(await judgeHostCommand(services, guards, { ...ASKED, command: "Dear team, the builds are tidy now.", typed: true })).toBeUndefined();
        const judged = judgeHostCommand(services, guards, { ...ASKED, typed: true }, 20);
        expect(await judged).toEqual({
            refusal:
                'Still waiting for the owner: a card asks them to approve typing this on "rog", and nothing has been typed yet. Their answer is ' +
                "kept for this exact text: make the same call again with exactly the same text to wait for it. You may also carry on with other " +
                "work or end your turn: the card stays up until they answer, and if they allow it you are told to make this call again. Nothing " +
                "is broken on the device and nothing refused this, so do not report it as refused or blocked. Do not type a different command " +
                "to do the same thing.",
        });
        await cardUp();
        const card = turnRunOf(fleet.conversations, CONVERSATION)
            ?.rows.map((row) => row.permission)
            .find((permission) => permission?.status === "pending");
        expect(card).toMatchObject({ title: "Type this on rog?", displayName: "Type on rog", toolName: "rog__device" });
    });

    it("is refused at once, naming the switch, when the device would refuse it", async () => {
        destructive = "off";
        expect(await judgeHostCommand(services, guards, { ...ASKED, command: "find ~/old-builds -depth -delete", typed: true })).toMatchObject({
            refusal: expect.stringMatching(/^Refused: typed into a terminal, this would delete files recursively on "rog"/),
        });
    });
});

describe("a command for a phone attached to the device", () => {
    const payload = (name: string, args: Record<string, unknown>) => ({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name, arguments: args },
    });

    it("is judged as the adb program the device runs for it, and a machine command stays as it was sent", () => {
        expect(commandInCall(payload("run_command", { command: "rm -rf ~/old-builds" }))).toBe("rm -rf ~/old-builds");
        expect(commandInCall(payload("android_shell", { command: "pm uninstall com.example.app" }))).toBe("adb shell pm uninstall com.example.app");
        expect(commandInCall(payload("android_shell", { serial: "192.168.1.20:37005", command: "rm -rf /sdcard/old" }))).toBe(
            "adb -s 192.168.1.20:37005 shell rm -rf /sdcard/old",
        );
        // A serial that could make the command after it read as a comment or a string is left out, not spliced in.
        expect(commandInCall(payload("android_shell", { serial: "x #", command: "rm -rf /sdcard/old" }))).toBe("adb shell rm -rf /sdcard/old");
        expect(commandInCall(payload("android_shell", { command: "  " }))).toBeUndefined();
        expect(commandInCall(payload("android_screenshot", {}))).toBeUndefined();
    });

    it("passes at no cost when it deletes nothing, and is refused at once when the device's switch would refuse it", async () => {
        expect(await judgeHostCommand(services, guards, { ...ASKED, command: "adb shell pm list packages -3" })).toBeUndefined();
        destructive = "off";
        expect(await judgeHostCommand(services, guards, { ...ASKED, command: "adb -s R58M12ABCDE shell rm -rf /sdcard/DCIM/old" })).toMatchObject({
            refusal: expect.stringMatching(/^Refused: this command would delete files recursively on "rog"/),
        });
    });

    it("is asked about on a card showing the adb program, and its answer is kept for that program alone", async () => {
        const phone = { ...ASKED, command: "adb shell rm -rf /sdcard/Download/old" };
        expect(await judgeHostCommand(services, guards, phone, 20)).toMatchObject({ refusal: expect.stringMatching(/^Still waiting for the owner/) });
        const card = turnRunOf(fleet.conversations, CONVERSATION)
            ?.rows.map((row) => row.permission)
            .find((permission) => permission?.status === "pending");
        expect(card).toMatchObject({ title: "Run this on rog?", program: { text: "adb shell rm -rf /sdcard/Download/old" } });
        expect(cards.resolve({ kind: "permission", requestId: await cardUp(), decision: "once" })).toBe("settled");
        // The same words sent to the machine's own shell are a different program, asked about afresh.
        const machine = judgeHostCommand(services, guards, { ...ASKED, command: "rm -rf /sdcard/Download/old" }, 20);
        expect(await machine).toMatchObject({ refusal: expect.stringMatching(/^Still waiting for the owner/) });
        expect(await judgeHostCommand(services, guards, phone, 20)).toBeUndefined();
    });
});
