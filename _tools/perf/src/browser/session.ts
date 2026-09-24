import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import type { ScriptCoverage } from "./coverage.js";
import { installProbe, pauseClock, type Probe, type ProbeOptions, type ProbeReadout } from "./page-probe.js";

/** Everything the counts depend on that the harness chooses, so a baseline can name it. */
export const VIEWPORT = { width: 1440, height: 900 } as const;
const DEVICE_SCALE_FACTOR = 1;
// A fixed wall clock: the fixture stamps its roster relative to page load, and every readout formats Date.now().
const START = Date.UTC(2026, 0, 15, 10, 0, 0);
// Fake ms per step. The clock yields between timers through microtasks, so a fetch a timer starts lands after the whole
// step whatever its size; a smaller step lets it land before the timers that would have followed it in a real browser.
const STEP_MS = 250;
// Still flushes in a row before the page counts as settled: a module that just arrived is parsed before the requests
// for its own imports go out, and the network reports it done before the page has read it.
const QUIET_FLUSHES = 3;
// Wall-clock ms without a request starting or finishing before a page that will not go quiet is given up on.
const STALL_MS = 60_000;
const BLANK = "/perf-blank";

/** One measured window's raw counts, before they are folded into a reading. */
export interface Window {
    readonly probe: ProbeReadout;
    readonly scripts: readonly ScriptCoverage[];
    readonly layouts: number;
    readonly styles: number;
}

type ProbeScope = typeof globalThis & { readonly perfProbe: Probe };
type ClockScope = typeof globalThis & Record<string, { controller: { runFor: (ms: number) => Promise<void> } }>;

export class Session {
    private inflight = 0;
    private started = 0;
    private navigations = 0;

    private constructor(
        private readonly context: BrowserContext,
        readonly page: Page,
        private readonly cdp: CDPSession,
        private readonly origin: string,
    ) {
        page.on("request", () => {
            this.inflight += 1;
            this.started += 1;
        });
        page.on("requestfinished", () => void (this.inflight -= 1));
        page.on("requestfailed", () => void (this.inflight -= 1));
        // A document load, not `framenavigated`: the router's own history writes are same-document navigations too.
        page.on("domcontentloaded", () => {
            this.navigations += 1;
        });
    }

    /** A fresh context: nothing cached, nothing stored, the clock paused at `START` before the first document. */
    static async open(browser: Browser, origin: string, options: ProbeOptions): Promise<Session> {
        const context = await browser.newContext({
            viewport: VIEWPORT,
            deviceScaleFactor: DEVICE_SCALE_FACTOR,
            locale: "en-US",
            timezoneId: "UTC",
            colorScheme: "light",
            reducedMotion: "reduce",
            serviceWorkers: "block",
        });
        await context.addInitScript(installProbe, options);
        await context.clock.pauseAt(START);
        await context.addInitScript(pauseClock, START);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Profiler.enable");
        // Started before any app script compiles, so every function's count is exact from its first call.
        await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
        await cdp.send("Performance.enable");
        return new Session(context, page, cdp, origin);
    }

    /** A same-origin empty document, so a cold load stays in this renderer and its counters carry across. */
    async blank(): Promise<void> {
        const url = `${this.origin}${BLANK}`;
        await this.page.route(url, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
        await this.page.goto(url);
        await this.page.unroute(url);
    }

    /** Navigates and lets the page settle for `settleMs` of fake time. */
    async open(path: string, settleMs: number): Promise<void> {
        await this.page.goto(`${this.origin}${path}`, { waitUntil: "commit" });
        await this.quiesce();
        await this.advance(settleMs);
    }

    /** Runs the fake clock forward in steps, letting each step's real work (fetches, frames) finish before the next. */
    async advance(ms: number, step = STEP_MS): Promise<void> {
        for (let done = 0; done < ms; done += step) {
            await this.page.evaluate((next) => (globalThis as ClockScope)["__pwClock"]!.controller.runFor(next), Math.min(step, ms - done));
            await this.quiesce();
        }
    }

    /**
     * Waits until the page is still: no request in flight, none started, and nothing mutated, mounted or rendered
     * across `QUIET_FLUSHES` flushes in a row. Each flush forces style and layout and waits two real frames, so whatever
     * an input dirtied is laid out once, here, and not wherever a frame happened to fall.
     */
    async quiesce(): Promise<void> {
        let quiet = 0;
        let changes = -1;
        let progress = { at: Date.now(), inflight: this.inflight, started: this.started };
        while (quiet < QUIET_FLUSHES) {
            const started = this.started;
            const changed = await this.page.evaluate(() => (globalThis as ProbeScope).perfProbe.flush());
            quiet = this.inflight === 0 && this.started === started && changed === changes ? quiet + 1 : 0;
            changes = changed;
            if (this.inflight !== progress.inflight || this.started !== progress.started) {
                progress = { at: Date.now(), inflight: this.inflight, started: this.started };
            } else if (Date.now() - progress.at > STALL_MS) {
                throw new Error(`page stalled: ${this.inflight} requests in flight and none moved for ${STALL_MS / 1000}s`);
            }
        }
    }

    /** Counts what `act` costs, from a settled page to a settled page; `navigations` is how many documents `act` loads. */
    async measure(act: () => Promise<void>, navigations = 0): Promise<Window> {
        await this.quiesce();
        await this.page.evaluate(() => (globalThis as ProbeScope).perfProbe.take());
        // Taking coverage zeroes V8's counters, so this take is the window's start.
        await this.cdp.send("Profiler.takePreciseCoverage");
        const before = await this.metrics();
        const navigatedBefore = this.navigations;
        await act();
        await this.quiesce();
        if (this.navigations - navigatedBefore !== navigations) {
            throw new Error(
                `${this.navigations - navigatedBefore} documents loaded in a window that loads ${navigations}: a reload ran under the measurement`,
            );
        }
        const probe = await this.page.evaluate(() => (globalThis as ProbeScope).perfProbe.take());
        const after = await this.metrics();
        const { result } = await this.cdp.send("Profiler.takePreciseCoverage");
        return {
            probe,
            scripts: result,
            layouts: after.layouts - before.layouts,
            styles: after.styles - before.styles,
        };
    }

    private async metrics(): Promise<{ layouts: number; styles: number }> {
        const { metrics } = await this.cdp.send("Performance.getMetrics");
        const value = (name: string): number => metrics.find((metric) => metric.name === name)?.value ?? Number.NaN;
        return { layouts: value("LayoutCount"), styles: value("RecalcStyleCount") };
    }

    async close(): Promise<void> {
        await this.context.close();
    }
}
