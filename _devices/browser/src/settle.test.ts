import { ACTION_SETTLE_MAX_MS, OPEN_SETTLE_MAX_MS, type PageAnswer, type SettleClock, settleAfterAction, settleAfterOpen } from "./settle.js";

/* An action's wait ends on the page's own signals: the DOM going quiet, or the next document parsing when the action
   navigated. The old fixed sleeps are the caps, so no call waits longer than it did (2026-10-20). The page is stood in for
   by what each script it is handed answers; time is a hand-driven clock. */

const fakeClock = (): SettleClock & { elapsed: () => number } => {
    let at = 0;
    return { now: () => at, sleep: async (ms) => void (at += ms), elapsed: () => at };
};

// A page answering from a script of outcomes, one per evaluate: a value, or a thrown "the context went away".
const scripted = (answers: readonly (PageAnswer | Error)[], clock: ReturnType<typeof fakeClock>, eachMs = 0) => {
    const asked: string[] = [];
    const run = async (script: string): Promise<PageAnswer> => {
        asked.push(script.includes("MutationObserver") ? "quiet" : "parsed");
        await clock.sleep(eachMs);
        const answer = answers[asked.length - 1];
        if (answer instanceof Error) {
            throw answer;
        }
        return answer;
    };
    return { run, asked };
};

test("a page that goes quiet ends the wait at once, without a second look", async () => {
    const clock = fakeClock();
    const page = scripted(["quiet"], clock, 120);
    await settleAfterAction(page.run, clock);
    expect(page.asked).toEqual(["quiet"]);
    expect(clock.elapsed()).toBe(120);
});

test("an action that navigates waits for the next document to parse, within the same cap", async () => {
    const clock = fakeClock();
    const destroyed = new Error("Execution context was destroyed.");
    const page = scripted([destroyed, destroyed, "quiet"], clock, 30);
    await settleAfterAction(page.run, clock);
    // Two tries found no document; the third ran in the new one.
    expect(page.asked).toEqual(["quiet", "quiet", "quiet"]);
    expect(clock.elapsed()).toBeLessThanOrEqual(ACTION_SETTLE_MAX_MS);
});

test("a page that began leaving is not taken as done: the new document's parse is waited for", async () => {
    const clock = fakeClock();
    const page = scripted(["left", true], clock, 100);
    await settleAfterAction(page.run, clock);
    expect(page.asked).toEqual(["quiet", "parsed"]);
});

test("a page that never answers costs the old fixed beat and no more", async () => {
    const clock = fakeClock();
    const page = scripted(Array.from({ length: 100 }, () => new Error("no context")), clock);
    await settleAfterAction(page.run, clock);
    expect(clock.elapsed()).toBe(ACTION_SETTLE_MAX_MS);
    const open = fakeClock();
    await settleAfterOpen(scripted(Array.from({ length: 100 }, () => new Error("no context")), open).run, open);
    expect(open.elapsed()).toBe(OPEN_SETTLE_MAX_MS);
});

test("opening a tab ends once its document has parsed", async () => {
    const clock = fakeClock();
    const page = scripted([true], clock, 40);
    await settleAfterOpen(page.run, clock);
    expect(page.asked).toEqual(["parsed"]);
    expect(clock.elapsed()).toBe(40);
});
