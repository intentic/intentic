import type { Browser } from "playwright";
import type { CpuProfile } from "./attribution.js";
import { interactions, layoutShift, longestTask, longTaskTotal, median, paintAt } from "./measures.js";
import { Phone } from "./phone.js";

// What a phone does in the editor, each as one measured run in a fresh context: open the app, sit on the board, open a
// long conversation, fling through it, type in its composer. Numbers are milliseconds unless named otherwise.

export interface RunOptions {
    readonly browser: Browser;
    /** Where the built demo is served, `http://127.0.0.1:<port>`. */
    readonly origin: string;
    readonly cpu: number;
    readonly replay: boolean;
    /** How many copies of the fixture conversation's rows (7 each) the long chat is inflated to. */
    readonly copies: number;
    /** Profile the measured action, for attribution. */
    readonly profile: boolean;
}

export interface Measured {
    readonly numbers: Readonly<Record<string, number>>;
    readonly notes: readonly string[];
    /** The measured action's CPU profile, when the run was asked to take one. */
    readonly profile: CpuProfile | undefined;
}

export interface Scenario {
    readonly name: string;
    readonly about: string;
    readonly run: (options: RunOptions) => Promise<Measured>;
}

// The fixture conversation with the most to draw: prompts, answers, edits with diffs, a job row.
const LONG_CHAT = `cnv_soft_deletes`;
// The recording with every agent and extension on, which is the busiest board the demo can draw.
const FULL = `?mode=full`;
// Long enough for a first screen, its chunks and its first round of reads to settle at 4× throttle.
const SETTLE_MS = 8_000;

const within = async (phone: Phone, options: RunOptions, act: () => Promise<void>): Promise<CpuProfile | undefined> => {
    if (!options.profile) {
        await act();
        return undefined;
    }
    return phone.profile(act);
};

// How long a start is watched: its first screen, its chunks and its first reads.
const LOAD_MS = 6_000;

// A start's numbers: paints, long tasks, layout shift not caused by input with the nodes it moved, and the scripts it
// ran, both as decoded and as they came over the wire (a cached one comes over as nothing).
const loaded = async (phone: Phone): Promise<Omit<Measured, "profile">> => {
    const record = await phone.take();
    const scripts = await phone.page.evaluate(() => {
        const js = performance
            .getEntriesByType(`resource`)
            .filter((entry) => entry instanceof PerformanceResourceTiming)
            .filter((entry) => entry.name.endsWith(`.js`));
        const kb = (bytes: number): number => Math.round(bytes / 1024);
        return {
            count: js.length,
            decodedKB: kb(js.reduce((sum, entry) => sum + entry.decodedBodySize, 0)),
            fetchedKB: kb(js.reduce((sum, entry) => sum + entry.transferSize, 0)),
        };
    });
    return {
        numbers: {
            fcp: paintAt(record, `first-contentful-paint`) ?? -1,
            lcp: record.lcp.at(-1)?.start ?? -1,
            longTasks: longTaskTotal(record.longTasks),
            longestTask: longestTask(record.longTasks),
            cls: layoutShift(record.shifts),
            jsFiles: scripts.count,
            jsDecodedKB: scripts.decodedKB,
            jsFetchedKB: scripts.fetchedKB,
        },
        notes: record.shifts
            .filter((shift) => !shift.recentInput && shift.value > 0.01)
            .flatMap((shift) => shift.sources.map((source) => `shift ${shift.value.toFixed(3)}: ${source}`)),
    };
};

const openLongChat = async (options: RunOptions): Promise<{ readonly phone: Phone }> => {
    const phone = await Phone.open(options.browser, {
        cpu: options.cpu,
        replay: options.replay,
        transcript: { conversationId: LONG_CHAT, copies: options.copies },
    });
    await phone.visit(options.origin, `/agents${FULL}`);
    await phone.page.waitForTimeout(SETTLE_MS);
    return { phone };
};

export const SCENARIOS: readonly Scenario[] = [
    {
        name: `load`,
        about: `a cold start on the board: first paint, largest paint, long tasks, layout shift, JS fetched`,
        run: async (options) => {
            const phone = await Phone.open(options.browser, { cpu: options.cpu, replay: options.replay });
            try {
                const profile = await within(phone, options, async () => {
                    await phone.visit(options.origin, `/agents`);
                    await phone.page.waitForTimeout(LOAD_MS);
                });
                return { ...(await loaded(phone)), profile };
            } finally {
                await phone.close();
            }
        },
    },
    {
        name: `reload`,
        about: `a returning visit: the board reloaded with what a first visit stored (roster, shared access) and cached`,
        run: async (options) => {
            const phone = await Phone.open(options.browser, { cpu: options.cpu, replay: options.replay });
            try {
                await phone.visit(options.origin, `/agents`);
                await phone.page.waitForTimeout(LOAD_MS);
                // The page's observers start over with the new document, so what is taken next is the reload's alone.
                const profile = await within(phone, options, async () => {
                    await phone.reload();
                    await phone.page.waitForTimeout(LOAD_MS);
                });
                return { ...(await loaded(phone)), profile };
            } finally {
                await phone.close();
            }
        },
    },
    {
        name: `idle-board`,
        about: `the full board left alone for 5s: how busy the main thread stays, and how often it restyles`,
        run: async (options) => {
            const phone = await Phone.open(options.browser, { cpu: options.cpu, replay: options.replay });
            try {
                await phone.visit(options.origin, `/agents${FULL}`);
                await phone.page.waitForTimeout(SETTLE_MS);
                let profile: CpuProfile | undefined;
                const busy = await phone.busy(async () => {
                    profile = await within(phone, options, () => phone.page.waitForTimeout(5_000));
                });
                return {
                    numbers: { busyPct: Math.round(busy.taskMs / 50), styleLayout: busy.styleLayoutMs, styleRecalcs: busy.styleRecalcs },
                    notes: [],
                    profile,
                };
            } finally {
                await phone.close();
            }
        },
    },
    {
        name: `open-chat`,
        about: `a tap on a card into a long conversation: the tap's INP and its parts, first content, long tasks, layout shift`,
        run: async (options) => {
            const { phone } = await openLongChat(options);
            try {
                const card = phone.page.locator(`.session-card`, { hasText: /soft delete/iu }).first();
                await card.scrollIntoViewIfNeeded();
                await phone.page.waitForTimeout(1_000);
                await phone.take();
                let firstContent = -1;
                const profile = await within(phone, options, async () => {
                    const started = Date.now();
                    await card.tap();
                    await phone.page.waitForFunction(() => document.querySelectorAll(`.chat-markdown`).length > 3, undefined, { timeout: 120_000 });
                    firstContent = Date.now() - started;
                    await phone.page.waitForTimeout(SETTLE_MS);
                });
                const record = await phone.take();
                const tap = interactions(record.events)[0];
                return {
                    numbers: {
                        tap: tap?.duration ?? 0,
                        tapInputDelay: tap?.inputDelay ?? 0,
                        tapProcessing: tap?.processing ?? 0,
                        tapPresentation: tap?.presentation ?? 0,
                        firstContent,
                        longTasks: longTaskTotal(record.longTasks),
                        longestTask: longestTask(record.longTasks),
                        cls: layoutShift(record.shifts),
                        domNodes: await phone.page.evaluate(() => document.getElementsByTagName(`*`).length),
                    },
                    notes: record.frames
                        .filter((frame) => frame.duration >= 200)
                        .map((frame) => `frame ${frame.duration}ms (style+layout ${frame.styleLayout}): ${frame.scripts.join(`; `)}`),
                    profile,
                };
            } finally {
                await phone.close();
            }
        },
    },
    {
        name: `scroll-chat`,
        about: `flinging up through the long conversation: frame intervals while it scrolls`,
        run: async (options) => {
            const phone = await Phone.open(options.browser, {
                cpu: options.cpu,
                replay: options.replay,
                transcript: { conversationId: LONG_CHAT, copies: options.copies },
            });
            try {
                await phone.visit(options.origin, `/agents/${LONG_CHAT}${FULL}`);
                await phone.page.waitForFunction(() => document.querySelectorAll(`.chat-markdown`).length > 3, undefined, { timeout: 120_000 });
                await phone.page.waitForTimeout(SETTLE_MS);
                const box = await phone.page.evaluate(() => {
                    const rect = document.querySelector(`.chat-scroller`)?.getBoundingClientRect();
                    return rect === undefined ? undefined : { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
                });
                if (box === undefined) {
                    throw new Error(`no chat scroller on the page`);
                }
                await phone.page.evaluate(() => {
                    const frames: number[] = [];
                    window.perfFrames = frames;
                    let last = performance.now();
                    const tick = (now: number): void => {
                        frames.push(now - last);
                        last = now;
                        if (frames.length < 3_000) {
                            requestAnimationFrame(tick);
                        }
                    };
                    requestAnimationFrame(tick);
                });
                const profile = await within(phone, options, async () => {
                    for (let fling = 0; fling < 4; fling += 1) {
                        await phone.cdp.send(`Input.synthesizeScrollGesture`, {
                            x: box.x,
                            y: box.y,
                            yDistance: 1_500,
                            speed: 2_500,
                            gestureSourceType: `mouse`,
                        });
                    }
                });
                const frames = (await phone.page.evaluate(() => window.perfFrames ?? [])).slice(2);
                const sorted = frames.toSorted((a, b) => a - b);
                return {
                    numbers: {
                        frames: frames.length,
                        frameP50: Math.round(median(frames) * 10) / 10,
                        frameP90: Math.round((sorted[Math.floor(sorted.length * 0.9)] ?? 0) * 10) / 10,
                        framesOver50ms: frames.filter((frame) => frame > 50).length,
                    },
                    notes: [],
                    profile,
                };
            } finally {
                await phone.close();
            }
        },
    },
    {
        name: `type`,
        about: `typing a sentence into the long conversation's composer: each keystroke's interaction`,
        run: async (options) => {
            const phone = await Phone.open(options.browser, {
                cpu: options.cpu,
                replay: options.replay,
                transcript: { conversationId: LONG_CHAT, copies: options.copies },
            });
            try {
                await phone.visit(options.origin, `/agents/${LONG_CHAT}${FULL}`);
                await phone.page.waitForFunction(() => document.querySelectorAll(`.chat-markdown`).length > 3, undefined, { timeout: 120_000 });
                await phone.page.waitForTimeout(SETTLE_MS);
                await phone.page.locator(`textarea`).first().tap();
                await phone.page.waitForTimeout(1_000);
                await phone.take();
                const profile = await within(phone, options, async () => {
                    await phone.page.keyboard.type(`Please also add a test for the purge job`, { delay: 120 });
                    await phone.page.waitForTimeout(2_000);
                });
                const keys = interactions((await phone.take()).events).map((interaction) => interaction.duration);
                return {
                    numbers: { keystrokes: keys.length, keyP50: median(keys), keyMax: keys[0] ?? 0 },
                    notes: [],
                    profile,
                };
            } finally {
                await phone.close();
            }
        },
    },
];
