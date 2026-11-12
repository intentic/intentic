import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { RefusedError } from "../policy.js";
import { ROUND_MS, type WaitAsk, waitOnPage } from "./page-wait.js";

// The worker's half of wait_for: rounds, a page replaced or gone mid-wait, and the answer the agent reads. The page is
// jsdom and the injected functions run in it for real, as executeScript would run them; only Chrome's own calls are
// stood in for, and the clock is fake, so a nine-minute wait takes no time.

const TAB = 7;
const PAGE = "Page: Generated image\n[e1] button \"Generated image 1\"";

// What the fake browser does with the next injections: run them, throw as a removed frame does, or never answer.
let mode: "run" | "removed" | "frozen" = "run";
let tab: { id: number; url?: string; status?: string; discarded?: boolean } | undefined;
const rounds: { roundMs: number; last: boolean }[] = [];

const install = (): void => {
    Object.assign(globalThis, {
        chrome: {
            scripting: {
                executeScript: async ({ func, args }: { func: (...args: unknown[]) => Promise<object> | object; args: unknown[] }) => {
                    if (func.name === "waitRound") {
                        rounds.push({ roundMs: Number(args[2]), last: args[3] === true });
                    }
                    if (mode === "removed") {
                        throw new Error("Frame with ID 0 was removed.");
                    }
                    if (mode === "frozen") {
                        return await new Promise(() => undefined);
                    }
                    return [{ frameId: 0, result: await func(...args) }];
                },
            },
            tabs: {
                get: async () => {
                    if (tab === undefined) {
                        throw new Error(`No tab with id: ${TAB}.`);
                    }
                    return tab;
                },
                onUpdated: { addListener: () => undefined, removeListener: () => undefined },
            },
        },
    });
};

// What the page read after the wait refuses with, when the tab is now somewhere the agent may not read.
let refusal: string | undefined;
const read = async (): Promise<string> => {
    if (refusal !== undefined) {
        throw new RefusedError(refusal);
    }
    return PAGE;
};

// How a wait ended, if it did: its answer, or the refusal it ended with.
interface Outcome {
    answer?: string;
    refused?: string;
}

// The wait run to its end, or to the time given.
const settle = async (ask: WaitAsk, ms: number): Promise<Outcome> => {
    const outcome: Outcome = {};
    void waitOnPage(TAB, ask, read).then(
        (answer) => {
            outcome.answer = answer;
        },
        (error: Error) => {
            outcome.refused = error instanceof RefusedError ? error.message : `not a refusal: ${error.message}`;
        },
    );
    await advanceTimersByTimeAsync(ms);
    return outcome;
};

// A text node rewritten every second, from `from` until `until`.
const ticking = (selector: string, until = Number.POSITIVE_INFINITY): void => {
    const el = document.querySelector(selector);
    const started = Date.now();
    const timer = setInterval(() => {
        if (Date.now() - started > until) {
            clearInterval(timer);
            return;
        }
        if (el !== null) {
            el.textContent = `${Math.round((Date.now() - started) / 1000)} s`;
        }
    }, 1_000);
};

beforeEach(() => {
    jest.useFakeTimers();
    mode = "run";
    tab = { id: TAB, url: location.href, status: "complete" };
    rounds.length = 0;
    refusal = undefined;
    document.body.innerHTML = "";
    window.intenticWatches = {};
    install();
});

afterEach(() => {
    jest.useRealTimers();
});

test("a generation that takes minutes is waited out in one call, in short rounds, and answered as soon as the page settles", async () => {
    document.body.innerHTML = `<p>Thinking <span class="elapsed">0 s</span></p>`;
    // ChatGPT's "Thinking" counts up for two minutes, then the image lands and nothing moves.
    ticking(".elapsed", 120_000);
    const { answer } = await settle({ quietFor: 10, seconds: 540 }, 135_000);
    // The last tick is at 2 min; ten still seconds later the call answers.
    expect(answer).toBe(`After 2 min 10 s: the page has not changed for 10 s.\n\n${PAGE}`);
    // No single injected call ran for minutes: every round fits inside ROUND_MS.
    expect(rounds.length).toBeGreaterThanOrEqual(5);
    expect(rounds.every((round) => round.roundMs <= ROUND_MS)).toBe(true);
});

test("text met at once is said so, with the page", async () => {
    document.body.innerHTML = `<p>Response complete</p>`;
    expect((await settle({ text: "Response complete", seconds: 15 }, 0)).answer).toBe(`Already so when asked: "Response complete" appeared.\n\n${PAGE}`);
});

test("a timeout is an answer: what was still not so, what kept changing, what to do, and the page", async () => {
    document.body.innerHTML = `<p>Thinking</p><span class="clock">0 s</span>`;
    ticking(".clock");
    const { answer, refused } = await settle({ textGone: "Thinking", quietFor: 10, seconds: 60 }, 61_000);
    expect(refused).toBeUndefined();
    expect(answer).toContain(`Stopped waiting after 60 s, with the page not there yet. Still not so: "Thinking" is still on the page; the page never stayed unchanged for 10 s`);
    expect(answer).toMatch(/What kept changing: span\.clock "\d+ s": (59|60) changes in the last (59|60) s \(children\)\./);
    expect(answer).toContain(`wait for the text that marks the end instead of quietFor`);
    expect(answer).toMatch(/\n\nPage: Generated image/);
    // The last round was the one told it was last, so the watch stopped with it.
    expect(rounds.at(-1)?.last).toBe(true);
    expect(Object.keys(window.intenticWatches ?? {})).toEqual([]);
});

test("a page replaced between rounds is said as where it went, with the new page", async () => {
    document.body.innerHTML = `<p>Thinking</p>`;
    const from = location.href;
    setTimeout(() => {
        // A navigation: a fresh document, with nothing of the old watch in its isolated world.
        window.intenticWatches = {};
        tab = { id: TAB, url: "https://chatgpt.com/c/0b5e", status: "complete" };
    }, ROUND_MS + 5_000);
    const { answer } = await settle({ textGone: "Thinking", seconds: 540 }, 2 * ROUND_MS + 1_000);
    expect(answer).toBe(
        `The wait ended after 50 s because the page was replaced: it navigated from ${from} to https://chatgpt.com/c/0b5e. Nothing was waited for on the new page. If what you expect belongs to it, wait again.\n\n${PAGE}`,
    );
});

test("a page replaced by one the agent may not read is not named, whatever address Chrome hands over", async () => {
    document.body.innerHTML = `<p>Thinking</p>`;
    const from = location.href;
    setTimeout(() => {
        window.intenticWatches = {};
        tab = { id: TAB, url: "https://bank.example/statements?account=1234", status: "complete" };
        refusal = "Not allowed on bank.example. Call ask_access with a plain reason and stop.";
    }, ROUND_MS + 5_000);
    const { answer } = await settle({ textGone: "Thinking", seconds: 540 }, 2 * ROUND_MS + 1_000);
    expect(answer).toBe(
        `The wait ended after 50 s because the page was replaced: it navigated away from ${from}. Nothing was waited for on the new page. If what you expect belongs to it, wait again. Not allowed on bank.example. Call ask_access with a plain reason and stop.`,
    );
});

test("a page replaced under a running round is told apart from one that failed, by asking it again", async () => {
    document.body.innerHTML = `<p>Thinking</p>`;
    setTimeout(() => {
        mode = "removed";
    }, 1_000);
    setTimeout(() => {
        mode = "run";
        window.intenticWatches = {};
        tab = { id: TAB, url: location.href, status: "complete" };
    }, ROUND_MS + 2_000);
    const { answer } = await settle({ textGone: "Thinking", seconds: 540 }, ROUND_MS + 3_000);
    expect(answer).toContain(`because the page was replaced: it reloaded (${location.href})`);
});

test("a closed tab and a frozen page end the wait with what happened, not a generic failure", async () => {
    document.body.innerHTML = `<p>Thinking</p>`;
    setTimeout(() => {
        tab = undefined;
        mode = "removed";
    }, ROUND_MS + 1_000);
    expect((await settle({ textGone: "Thinking", seconds: 540 }, 2 * ROUND_MS)).refused).toBe(
        `The tab was closed after 50 s of waiting, so there is nothing left to wait on.`,
    );

    mode = "run";
    tab = { id: TAB, url: location.href, status: "complete" };
    setTimeout(() => {
        mode = "frozen";
    }, 1_000);
    // The round under way when it froze answers; the next is given its 25 s and 15 s more (40 s past 25), then asked once.
    expect((await settle({ textGone: "Thinking", seconds: 540 }, 2 * ROUND_MS + 30_000)).refused).toContain(`The page stopped answering after 65 s of waiting`);
});
