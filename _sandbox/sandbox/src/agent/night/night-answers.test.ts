import type { AskQuestion } from "@intentic/sandbox-contract/events/requests";
import { NightHoursSchema } from "@intentic/sandbox-contract/schemas/night-hours";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { formatAnswers } from "../../sessions/vocabulary/question-answers.js";
import { nightReply, OWN_JUDGEMENT, recommendedPicks } from "./night-answers.js";
import { nightClock, type NightNow, nightNow } from "./night-hours.js";

// What night hours answer, and when they are in force at all: the owner's own switch and window on the sandbox's clock,
// and nobody at the editor.

const settingsWith = (nightHours: Partial<ReturnType<typeof NightHoursSchema.parse>>, timezone = "UTC") =>
    SandboxSettingsSchema.parse({ timezone, nightHours: NightHoursSchema.parse(nightHours) });
const THREE_AM = Date.parse("2026-11-05T03:00:00Z");
const NOON = Date.parse("2026-11-05T12:00:00Z");

const DECIDE: NightNow = { questions: "decide", until: "07:00" };
const DEFER: NightNow = { questions: "defer", until: "07:00" };

const ask = (options: readonly string[], multiSelect = false, question = "Which approach?"): AskQuestion => ({
    question,
    header: "Approach",
    multiSelect,
    options: options.map((label) => ({ label, description: `${label}, described` })),
});

test("in force only when switched on, inside the window, and with nobody at the editor", () => {
    const on = settingsWith({ on: true });
    expect(nightNow(on, [], THREE_AM)).toEqual({ questions: "decide", until: "07:00" });
    // Somebody up at 3 a.m. and at a screen is asked as on any evening.
    expect(nightNow(on, ["owner@corp.com"], THREE_AM)).toBeUndefined();
    expect(nightNow(on, [], NOON)).toBeUndefined();
    expect(nightNow(settingsWith({ on: false }), [], THREE_AM)).toBeUndefined();
    expect(nightNow(undefined, [], THREE_AM)).toBeUndefined();
});

test("read on the sandbox's clock: 03:00 UTC is 04:00 in Warsaw, still night; 06:30 UTC is morning there", () => {
    const warsaw = settingsWith({ on: true, questions: "defer" }, "Europe/Warsaw");
    expect(nightNow(warsaw, [], THREE_AM)).toEqual({ questions: "defer", until: "07:00" });
    expect(nightNow(warsaw, [], Date.parse("2026-11-05T06:30:00Z"))).toBeUndefined();
});

// Lets every read the clock started settle.
const reads = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("the clock answers from its last read, and a saved change is the one the next card gets", async () => {
    let stored = settingsWith({ on: false });
    const listeners: (() => void)[] = [];
    const clock = nightClock({
        read: () => Promise.resolve(stored),
        onSet: (listener) => {
            listeners.push(listener);
            return () => undefined;
        },
        atEditor: () => [],
        clock: () => THREE_AM,
    });
    // Nothing read yet: nothing is answered for anyone on a guess.
    expect(clock.now()).toBeUndefined();
    // A save heard while the first read is still on its way is read again after it, never lost behind it.
    stored = settingsWith({ on: true });
    for (const listener of listeners) {
        listener();
    }
    await reads();
    expect(clock.now()).toEqual(DECIDE);
    stored = settingsWith({ on: false });
    for (const listener of listeners) {
        listener();
    }
    await reads();
    expect(clock.now()).toBeUndefined();
});

test("the pick is the option the agent marked recommended, else the first, where the ask tool says to put it", () => {
    expect(recommendedPicks(ask(["Keep it", "Rewrite it (Recommended)"]))).toEqual(["Rewrite it (Recommended)"]);
    expect(recommendedPicks(ask(["Keep it", "Rewrite it"]))).toEqual(["Keep it"]);
    // Several marked on a multi-select card are all taken; on a single-select only the first.
    expect(recommendedPicks(ask(["A (recommended)", "B (Recommended)", "C"], true))).toEqual(["A (recommended)", "B (Recommended)"]);
    expect(recommendedPicks(ask(["A (Recommended)", "B (Recommended)"]))).toEqual(["A (Recommended)"]);
    expect(recommendedPicks({ ...ask([]), options: [] })).toEqual([]);
});

test("under decide, every question on the card gets its pick, and a free-form one the agent's own judgement", () => {
    const pick = ask(["Keep it", "Rewrite it (Recommended)"]);
    const open = { ...ask([], false, "What should it be called?"), options: [] };
    expect(nightReply("r-1", { questions: [pick, open] }, DECIDE)).toEqual({
        kind: "question",
        requestId: "r-1",
        answers: { "Which approach?": ["Rewrite it (Recommended)"], "What should it be called?": [OWN_JUDGEMENT] },
        night: { outcome: "picked", until: "07:00" },
    });
});

test("under defer, the question is kept for the morning in words every runtime hands its agent as they are", () => {
    const reply = nightReply("r-2", { questions: [ask(["A", "B"])] }, DEFER);
    expect(reply).toMatchObject({ kind: "question", requestId: "r-2", night: { outcome: "saved", until: "07:00" } });
    const words = reply?.kind === "question" ? reply.answers?.["Which approach?"]?.[0] : undefined;
    expect(words).toContain("kept for the morning");
    expect(words).toContain("Do not decide it yourself");
});

test("a plan the agent chose is approved under decide, and waits for the morning under defer", () => {
    expect(nightReply("p-1", { plan: true }, DECIDE)).toMatchObject({ kind: "plan", requestId: "p-1", approve: true, night: { outcome: "approved", until: "07:00" } });
    expect(nightReply("p-1", { plan: true }, DEFER)).toBeUndefined();
});

test("the agent reads who chose, so it never takes a night pick for the owner's own", () => {
    const question = ask(["Keep it", "Rewrite it (Recommended)"]);
    const picked = nightReply("r-3", { questions: [question] }, DECIDE);
    const saved = nightReply("r-4", { questions: [question] }, DEFER);
    if (picked?.kind !== "question" || saved?.kind !== "question") {
        throw new Error("a question card is answered with a question reply");
    }
    const pickedText = formatAnswers([question], picked);
    expect(pickedText).toContain("it is the owner's night");
    expect(pickedText).toContain("- Approach: Rewrite it (Recommended)");
    expect(pickedText).toContain("Decided while you slept");
    expect(formatAnswers([question], saved)).toContain("end your turn with this question and your recommendation");
});
