import type { Browser, BrowserContextOptions } from "playwright";
import type { CpuProfile } from "../mobile/attribution.js";
import { interactions, longestTask, longTaskTotal, median } from "../mobile/measures.js";
import { Phone } from "../mobile/phone.js";
import { streamTurn } from "./stream.js";

// What a long conversation costs to live with: opening it, a turn streaming into it, typing under it, scrolling up
// through it. Each is one measured run in a fresh context, on a desktop or (`--phone`) the phone lab's Galaxy S10.

export interface RunOptions {
    readonly browser: Browser;
    /** Where the built demo is served, `http://127.0.0.1:<port>`. */
    readonly origin: string;
    readonly cpu: number;
    readonly phone: boolean;
    /** How many copies of the fixture conversation's rows (7 each) the chat is inflated to. */
    readonly copies: number;
    /** How long the streamed turn runs, in ms. */
    readonly streamMs: number;
    readonly profile: boolean;
}

export interface Measured {
    readonly numbers: Readonly<Record<string, number>>;
    readonly profile: CpuProfile | undefined;
}

export interface Scenario {
    readonly name: string;
    readonly about: string;
    readonly run: (options: RunOptions) => Promise<Measured>;
}

/** The desktop a chat docks in on the review page; the browser track's viewport. */
export const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

// The fixture conversation with the most to draw: prompts, answers, edits with diffs, a job row.
const LONG_CHAT = `cnv_soft_deletes`;
// How long the chat is watched after its first rows show, for the rows mounted at idle to land.
const SETTLE_MS = 4_000;

const open = async (options: RunOptions): Promise<Phone> => {
    const phone = await Phone.open(options.browser, {
        cpu: options.cpu,
        transcript: { conversationId: LONG_CHAT, copies: options.copies },
        ...(options.phone ? {} : { device: DESKTOP }),
    });
    await phone.context.addInitScript(streamTurn, { conversationId: LONG_CHAT, ms: options.streamMs });
    return phone;
};

const visit = async (phone: Phone, options: RunOptions): Promise<number> => {
    const started = Date.now();
    await phone.visit(options.origin, `/agents/${LONG_CHAT}?mode=default`);
    await phone.page.waitForFunction(() => document.querySelectorAll(`.chat-message`).length > 3, undefined, { timeout: 120_000 });
    return Date.now() - started;
};

const rows = (phone: Phone): Promise<number> => phone.page.evaluate(() => document.querySelectorAll(`.chat-message`).length);

const within = async (phone: Phone, options: RunOptions, act: () => Promise<void>): Promise<CpuProfile | undefined> => {
    if (!options.profile) {
        await act();
        return undefined;
    }
    return phone.profile(act);
};

// Frame intervals from now until `stop`, read off the page's own animation frames.
const sampleFrames = (phone: Phone): Promise<void> =>
    phone.page.evaluate(() => {
        const frames: number[] = [];
        window.perfFrames = frames;
        let last = performance.now();
        const tick = (now: number): void => {
            frames.push(now - last);
            last = now;
            if (frames.length < 20_000) {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    });

const framesOf = async (phone: Phone): Promise<Record<string, number>> => {
    // The first two are the sampler's own start.
    const frames = (await phone.page.evaluate(() => window.perfFrames ?? [])).slice(2);
    const sorted = frames.toSorted((a, b) => a - b);
    const at = (share: number): number => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0) * 10) / 10;
    return { frameP50: at(0.5), frameP99: at(0.99), framesOver50ms: frames.filter((frame) => frame > 50).length };
};

export const SCENARIOS: readonly Scenario[] = [
    {
        name: `open`,
        about: `open the long chat by its address: first rows, rows drawn, long tasks, DOM size, heap`,
        run: async (options) => {
            const phone = await open(options);
            try {
                let firstContent = 0;
                const profile = await within(phone, options, async () => {
                    firstContent = await visit(phone, options);
                    await phone.page.waitForTimeout(SETTLE_MS);
                });
                const record = await phone.take();
                await phone.cdp.send(`HeapProfiler.collectGarbage`);
                const { usedSize } = await phone.cdp.send(`Runtime.getHeapUsage`);
                return {
                    numbers: {
                        firstContent,
                        rowsDrawn: await rows(phone),
                        longTasks: longTaskTotal(record.longTasks),
                        longestTask: longestTask(record.longTasks),
                        domNodes: await phone.page.evaluate(() => document.getElementsByTagName(`*`).length),
                        heapMB: Math.round(usedSize / 1e6),
                    },
                    profile,
                };
            } finally {
                await phone.close();
            }
        },
    },
    {
        name: `stream`,
        about: `send in the long chat and watch a turn stream under it: main-thread share, frames, long frames`,
        run: async (options) => {
            const phone = await open(options);
            try {
                await visit(phone, options);
                await phone.page.waitForTimeout(SETTLE_MS);
                await phone.page.locator(`textarea`).first().fill(`Keep going with the purge job`);
                await phone.page.waitForTimeout(500);
                await phone.take();
                await sampleFrames(phone);
                const started = Date.now();
                let busy = { taskMs: 0, styleLayoutMs: 0, styleRecalcs: 0 };
                const profile = await within(phone, options, async () => {
                    busy = await phone.busy(async () => {
                        // Pressed in the page, not through a locator: a role query forces a layout per candidate while
                        // the transcript changes under it, which a trace once showed as a 19-second frame of the harness's.
                        await phone.page.evaluate(() => {
                            const send = [...document.querySelectorAll(`button[aria-label]`)].find((button) =>
                                /^send/iu.test(button.getAttribute(`aria-label`) ?? ``),
                            );
                            if (!(send instanceof HTMLElement)) {
                                throw new Error(`no send button`);
                            }
                            send.click();
                        });
                        await phone.page.waitForFunction(() => window.perfChat?.done === true, undefined, {
                            timeout: options.streamMs + 60_000,
                            polling: 250,
                        });
                        await phone.page.waitForTimeout(1_000);
                    });
                });
                const wall = Date.now() - started;
                const record = await phone.take();
                return {
                    numbers: {
                        busyPct: Math.round((busy.taskMs / wall) * 100),
                        styleLayoutMs: busy.styleLayoutMs,
                        patches: await phone.page.evaluate(() => window.perfChat?.patches ?? 0),
                        ...(await framesOf(phone)),
                        longFrames: record.frames.length,
                        longestFrame: record.frames.reduce((most, frame) => Math.max(most, frame.duration), 0),
                        rowsDrawn: await rows(phone),
                    },
                    profile,
                };
            } finally {
                await phone.close();
            }
        },
    },
    {
        name: `type`,
        about: `type a sentence into the long chat's composer: each keystroke's interaction`,
        run: async (options) => {
            const phone = await open(options);
            try {
                await visit(phone, options);
                await phone.page.waitForTimeout(SETTLE_MS);
                await phone.page.locator(`textarea`).first().click();
                await phone.page.waitForTimeout(500);
                await phone.take();
                const profile = await within(phone, options, async () => {
                    await phone.page.keyboard.type(`Please also add a test for the purge job`, { delay: 80 });
                    await phone.page.waitForTimeout(1_500);
                });
                const keys = interactions((await phone.take()).events).map((interaction) => interaction.duration);
                // Event timing reports only keys of 16ms and over, so a quick key is not in the count at all.
                return { numbers: { keysOver16ms: keys.length, keyP50: median(keys), keyMax: Math.max(0, ...keys) }, profile };
            } finally {
                await phone.close();
            }
        },
    },
    {
        name: `scroll`,
        about: `fling up through the long chat: frame intervals, and the rows drawn as it climbs`,
        run: async (options) => {
            const phone = await open(options);
            try {
                await visit(phone, options);
                await phone.page.waitForTimeout(SETTLE_MS);
                const box = await phone.page.evaluate(() => {
                    const rect = document.querySelector(`.chat-scroller`)?.getBoundingClientRect();
                    return rect === undefined ? undefined : { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
                });
                if (box === undefined) {
                    throw new Error(`no chat scroller on the page`);
                }
                await sampleFrames(phone);
                const profile = await within(phone, options, async () => {
                    for (let fling = 0; fling < 8; fling += 1) {
                        await phone.cdp.send(`Input.synthesizeScrollGesture`, {
                            x: box.x,
                            y: box.y,
                            yDistance: 3_000,
                            speed: 4_000,
                            gestureSourceType: options.phone ? `touch` : `mouse`,
                        });
                    }
                });
                return { numbers: { ...(await framesOf(phone)), rowsDrawn: await rows(phone) }, profile };
            } finally {
                await phone.close();
            }
        },
    },
];
