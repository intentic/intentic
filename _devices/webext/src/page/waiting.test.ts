import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { type WaitConditions, type WaitRound, waitRound, watchPage } from "./waiting.js";

// wait_for inside the page, against jsdom's real MutationObserver and fake timers: the clock moves only when a test moves
// it, which is how a throttled page's coarse timers are stood in for. The worker's half (rounds, navigation, the answer
// the agent reads) is background/tools/page-wait.test.ts.

const ask = (conditions: Partial<WaitConditions>): WaitConditions => ({ text: undefined, textGone: undefined, quietMs: undefined, ...conditions });

// A round run to its end, or to the time given, whichever comes first.
const settle = async (round: Promise<WaitRound>, ms: number): Promise<WaitRound | undefined> => {
    let answer: WaitRound | undefined;
    void round.then((value) => {
        answer = value;
    });
    await advanceTimersByTimeAsync(ms);
    return answer;
};

beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = "";
    window.intenticWatches = {};
});

afterEach(() => {
    jest.useRealTimers();
});

// executeScript sends each function's source and re-parses it in the page, where no name of this module exists. Re-parsed
// the same way here: an imported helper inside either would throw there, and Chrome hands that back as a null result
// (the "Cannot read properties of null (reading 'message')" wait_for once kept failing with).
test("both injected functions work with nothing of their module around them, as they run in the page", async () => {
    // SAFETY: re-parsing the source is exactly what Chrome does with it, and yields the same function
    const watchAlone = new Function(`return (${watchPage.toString()})`)() as typeof watchPage;
    // SAFETY: as above
    const roundAlone = new Function(`return (${waitRound.toString()})`)() as typeof waitRound;
    document.body.innerHTML = `<p>loading</p>`;
    expect(watchAlone("w1")).toEqual({ url: location.href });
    setTimeout(() => {
        document.body.innerHTML = `<p>Saved</p>`;
    }, 300);
    expect(await settle(roundAlone("w1", ask({ text: "Saved", quietMs: 1000 }), 5_000, true), 5_000)).toMatchObject({ state: "met", textShown: true });
});

test("quietFor answers once the page has stopped changing for that long, and not before", async () => {
    document.body.innerHTML = `<p id="status">Thinking</p>`;
    watchPage("w");
    const status = document.getElementById("status");
    // Changes every second for five seconds, then stops.
    for (let second = 1; second <= 5; second += 1) {
        setTimeout(() => {
            if (status !== null) {
                status.textContent = `Thinking ${second}`;
            }
        }, second * 1000);
    }
    const round = waitRound("w", ask({ quietMs: 10_000 }), 25_000, false);
    // At 14 s the page has been still for 9.
    expect(await settle(round, 14_000)).toBeUndefined();
    const answer = await settle(round, 1_500);
    expect(answer).toMatchObject({ state: "met", busy: [] });
    expect(answer?.stillMs).toBeGreaterThanOrEqual(10_000);
});

test("a quiet stretch that began in one round counts in the next, so rounds lose nothing", async () => {
    document.body.innerHTML = `<p>Generating</p>`;
    watchPage("w");
    const first = await settle(waitRound("w", ask({ quietMs: 30_000 }), 20_000, false), 20_000);
    expect(first).toMatchObject({ state: "waiting" });
    expect(first?.stillMs).toBe(20_000);
    // Ten more seconds of nothing, in the second round, completes the thirty.
    expect(await settle(waitRound("w", ask({ quietMs: 30_000 }), 20_000, false), 10_100)).toMatchObject({ state: "met" });
});

test("text and quiet must hold at once: the image appearing is not enough while the page is still settling", async () => {
    document.body.innerHTML = `<p id="status">Thinking</p><div id="out"></div>`;
    watchPage("w");
    setTimeout(() => {
        document.getElementById("status")?.remove();
        const out = document.getElementById("out");
        if (out !== null) {
            out.textContent = "Generated image 1";
        }
    }, 3_000);
    // A caption added a second later is still the page settling.
    setTimeout(() => document.getElementById("out")?.setAttribute("data-done", "yes"), 4_000);
    const round = waitRound("w", ask({ text: "Generated image 1", textGone: "Thinking", quietMs: 5_000 }), 25_000, false);
    expect(await settle(round, 8_500)).toBeUndefined();
    expect(await settle(round, 1_000)).toMatchObject({ state: "met", textShown: true, textGoneShown: false });
});

test("a page that never stops changing ends its round still waiting, and names what keeps changing", async () => {
    document.body.innerHTML = `<header><span class="clock">12:00:00</span></header><p>Working</p>`;
    watchPage("w");
    const clock = document.querySelector(".clock");
    let tick = 0;
    setInterval(() => {
        tick += 1;
        if (clock !== null) {
            clock.textContent = `12:00:${String(tick).padStart(2, "0")}`;
        }
    }, 1_000);
    const answer = await settle(waitRound("w", ask({ quietMs: 5_000 }), 25_000, true), 25_000);
    expect(answer?.state).toBe("waiting");
    expect(answer?.longestStillMs).toBeLessThanOrEqual(1_000);
    expect(answer?.busy[0]).toMatch(/^span\.clock "12:00:2\d": 2\d changes in the last 2\d s \(children\)$/);
});

test("the extension's own banner and question do not count as the page changing", async () => {
    document.body.innerHTML = `<p>Done</p>`;
    watchPage("w");
    // What flashBanner and askConfirm do to a page (page/overlay.ts): a host on <html>, restyled, then removed.
    setTimeout(() => {
        const banner = document.createElement("div");
        banner.id = "intentic-agent-banner";
        document.documentElement.append(banner);
        banner.setAttribute("style", "all: initial");
        const question = document.createElement("div");
        question.setAttribute("data-intentic-ask", "q1");
        document.documentElement.append(question);
    }, 1_000);
    setTimeout(() => {
        document.getElementById("intentic-agent-banner")?.remove();
        document.querySelector("[data-intentic-ask]")?.remove();
    }, 2_000);
    // A script tag dropped into <head> is no change a person sees either.
    setTimeout(() => document.head.append(document.createElement("script")), 2_500);
    expect(await settle(waitRound("w", ask({ quietMs: 3_000 }), 25_000, false), 3_100)).toMatchObject({ state: "met" });
});

test("a round in a document the watch is not in says the page was replaced", async () => {
    document.body.innerHTML = `<p>Working</p>`;
    watchPage("w");
    expect(await settle(waitRound("w", ask({ quietMs: 5_000 }), 1_000, false), 1_000)).toMatchObject({ state: "waiting" });
    // A navigation: the isolated world starts again with the new document, and nothing of the old watch is in it.
    window.intenticWatches = {};
    document.body.innerHTML = `<p>Elsewhere</p>`;
    expect(await settle(waitRound("w", ask({ quietMs: 5_000 }), 25_000, false), 0)).toMatchObject({ state: "replaced", url: location.href });
});

test("a watch stops when its wait is met, after its last round, and by itself when no round comes", async () => {
    document.body.innerHTML = `<p>Ready</p>`;
    watchPage("met");
    expect(await settle(waitRound("met", ask({ text: "Ready" }), 25_000, false), 0)).toMatchObject({ state: "met" });
    expect(window.intenticWatches?.["met"]).toBeUndefined();

    watchPage("last");
    expect(await settle(waitRound("last", ask({ text: "Never" }), 1_000, true), 1_000)).toMatchObject({ state: "waiting", textShown: false });
    expect(window.intenticWatches?.["last"]).toBeUndefined();

    watchPage("dropped");
    expect(await settle(waitRound("dropped", ask({ text: "Never" }), 1_000, false), 1_000)).toMatchObject({ state: "waiting" });
    expect(Object.keys(window.intenticWatches ?? {})).toContain("dropped");
    await advanceTimersByTimeAsync(60_000);
    expect(window.intenticWatches?.["dropped"]).toBeUndefined();
});

// Text is read (innerText forces a layout) only after the page changed, never on a timer, so a still page is read once
// at the start of a round and once at its end (2026-10-20).
test("text is looked for again only when the page changed", async () => {
    document.body.innerHTML = `<p>Saving…</p>`;
    const reads = { count: 0 };
    const body = document.body;
    const real = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(body), "innerText") ?? Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");
    Object.defineProperty(body, "innerText", {
        configurable: true,
        get() {
            reads.count += 1;
            return real?.get?.call(body) ?? body.textContent;
        },
    });
    try {
        watchPage("w");
        expect(await settle(waitRound("w", ask({ text: "Saved" }), 10_000, false), 10_000)).toMatchObject({ state: "waiting" });
        expect(reads.count).toBe(2);
        setTimeout(() => {
            body.innerHTML = `<p>Done</p>`;
        }, 50);
        expect(await settle(waitRound("w", ask({ textGone: "Saving" }), 10_000, false), 200)).toMatchObject({ state: "met", textGoneShown: false });
    } finally {
        Reflect.deleteProperty(body, "innerText");
    }
});

// The page went still but the text has not come: nothing is due until the page changes again, so it is not read again
// until then. Re-arming the quiet mark at zero once quiet held read innerText on every timer tick for the whole round.
test("a page already still enough, waiting on text, is not read again until it changes", async () => {
    document.body.innerHTML = `<p>Generating</p>`;
    const reads = { count: 0 };
    const body = document.body;
    Object.defineProperty(body, "innerText", {
        configurable: true,
        get() {
            reads.count += 1;
            return body.textContent;
        },
    });
    try {
        watchPage("w");
        expect(await settle(waitRound("w", ask({ text: "Done", quietMs: 1_000 }), 10_000, false), 10_000)).toMatchObject({ state: "waiting", textShown: false });
        // The first look, the one when the quiet stretch was complete, and the round's end.
        expect(reads.count).toBeLessThanOrEqual(3);
    } finally {
        Reflect.deleteProperty(body, "innerText");
    }
});

test("a watch whose first round never comes stops by itself", async () => {
    watchPage("orphan");
    await advanceTimersByTimeAsync(60_000);
    expect(window.intenticWatches?.["orphan"]).toBeUndefined();
});

// A round the worker gave up on (a page frozen, then thawed) may end after the next has started. It must neither take the
// running round's ear nor leave a timer that stops the watch under a later round: stopped, the watch hears nothing more,
// and a page still changing reads as quiet.
test("a late round ending under a newer one leaves that round and the watch alone", async () => {
    document.body.innerHTML = `<p id="status">0</p>`;
    const status = document.getElementById("status");
    const timer = setInterval(() => {
        if (status !== null) {
            status.textContent = String(Date.now());
        }
    }, 1_000);
    try {
        watchPage("w");
        const stale = waitRound("w", ask({ quietMs: 5_000 }), 30_000, false);
        await advanceTimersByTimeAsync(1_000);
        const current = waitRound("w", ask({ quietMs: 5_000 }), 150_000, false);
        // The stale round ends at 30 s, under the current one.
        expect(await settle(stale, 29_500)).toMatchObject({ state: "waiting" });
        // Past the abandon window the stale round would have armed: the page kept changing, so the wait is not met.
        expect(await settle(current, 90_000)).toBeUndefined();
        expect(Object.keys(window.intenticWatches ?? {})).toContain("w");
    } finally {
        clearInterval(timer);
    }
});
