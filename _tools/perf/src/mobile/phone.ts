import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import type { CpuProfile } from "./attribution.js";
import { enableAnalytics, inflateTranscript, observePerformance, type PageRecord } from "./page-scripts.js";

/**
 * The phone: a Galaxy S10-class Android in Chrome, as the field data describes it (PostHog web vitals from the owner's
 * device report a 412px-wide viewport). The CPU is slowed by a factor (4 by default, Lighthouse's own mobile setting)
 * since a phone's JavaScript runs several times slower than the machine measuring it; the network is not throttled, so
 * what a run shows is the CPU's share of a phone's time, which is the part the app decides.
 */
export const PHONE = {
    viewport: { width: 412, height: 869 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: `Mozilla/5.0 (Linux; Android 12; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36`,
} as const;

export interface PhoneOptions {
    /** CPU slowdown factor, 1 for none. */
    readonly cpu: number;
    /** Runs the app's real analytics and session replay against the local stand-in (wire.ts). */
    readonly replay?: boolean;
    /** Inflates this conversation's transcript to `copies` copies of its rows. */
    readonly transcript?: { readonly conversationId: string; readonly copies: number };
}

export class Phone {
    private constructor(
        readonly context: BrowserContext,
        readonly page: Page,
        readonly cdp: CDPSession,
    ) {}

    static async open(browser: Browser, options: PhoneOptions): Promise<Phone> {
        const context = await browser.newContext({ ...PHONE, locale: `en-US` });
        await context.addInitScript(observePerformance);
        if (options.replay === true) {
            await context.addInitScript(enableAnalytics);
        }
        if (options.transcript !== undefined) {
            await context.addInitScript(inflateTranscript, options.transcript);
        }
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send(`Emulation.setCPUThrottlingRate`, { rate: options.cpu });
        await cdp.send(`Performance.enable`);
        return new Phone(context, page, cdp);
    }

    /** Opens a demo path and waits for the app to have replaced its boot frame. */
    async visit(origin: string, path: string): Promise<void> {
        await this.page.goto(`${origin}/demo${path}`, { waitUntil: `domcontentloaded` });
        await this.booted();
    }

    /** Reloads the page as a returning visit would, keeping what the last visit stored and cached. */
    async reload(): Promise<void> {
        await this.page.reload({ waitUntil: `domcontentloaded` });
        await this.booted();
    }

    private async booted(): Promise<void> {
        await this.page.waitForFunction(() => document.querySelector(`.boot`) === null, undefined, { timeout: 120_000 });
    }

    /** What the observers gathered since the last take, emptied as it is read. */
    take(): Promise<PageRecord> {
        return this.page.evaluate(() => {
            const record = window.perfMobile;
            if (record === undefined) {
                throw new Error(`the page has no performance record: observePerformance did not run before the app`);
            }
            const copy = structuredClone(record);
            for (const list of Object.values(record)) {
                list.length = 0;
            }
            return copy;
        });
    }

    /** Main-thread time spent over `run`, by Chrome's own account: all tasks, and style and layout alone. */
    async busy(run: () => Promise<void>): Promise<{ readonly taskMs: number; readonly styleLayoutMs: number; readonly styleRecalcs: number }> {
        const metric = (metrics: { metrics: { name: string; value: number }[] }, name: string): number =>
            metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
        const before = await this.cdp.send(`Performance.getMetrics`);
        await run();
        const after = await this.cdp.send(`Performance.getMetrics`);
        const delta = (name: string): number => metric(after, name) - metric(before, name);
        return {
            taskMs: Math.round(delta(`TaskDuration`) * 1000),
            styleLayoutMs: Math.round((delta(`RecalcStyleDuration`) + delta(`LayoutDuration`)) * 1000),
            styleRecalcs: delta(`RecalcStyleCount`),
        };
    }

    /** A V8 CPU profile of `run`, sampled every 200µs. */
    async profile(run: () => Promise<void>): Promise<CpuProfile> {
        await this.cdp.send(`Profiler.enable`);
        await this.cdp.send(`Profiler.setSamplingInterval`, { interval: 200 });
        await this.cdp.send(`Profiler.start`);
        await run();
        const { profile } = await this.cdp.send(`Profiler.stop`);
        return profile;
    }

    close(): Promise<void> {
        return this.context.close();
    }
}
