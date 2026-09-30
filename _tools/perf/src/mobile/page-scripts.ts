// Scripts the phone's page runs before the app does. Each is serialised by Playwright into the page, so it can reach
// nothing but its own argument and the page's globals.

export interface Paint {
    readonly name: string;
    readonly start: number;
}

export interface LargestPaint {
    readonly start: number;
    readonly element: string;
}

export interface LongTask {
    readonly start: number;
    readonly duration: number;
}

export interface Shift {
    readonly start: number;
    readonly value: number;
    readonly recentInput: boolean;
    /** The nodes that moved, each `node x,y,w,h → x,y,w,h`. */
    readonly sources: readonly string[];
}

export interface EventTiming {
    readonly name: string;
    /** The interaction the event belongs to; 0 for an event that is not part of one. */
    readonly interaction: number;
    readonly start: number;
    readonly duration: number;
    readonly inputDelay: number;
    readonly processing: number;
    readonly presentation: number;
    readonly target: string;
}

export interface Frame {
    readonly start: number;
    readonly duration: number;
    readonly styleLayout: number;
    readonly scripts: readonly string[];
}

/** What the page's observers gathered, as `window.perfMobile` holds it. */
export interface PageRecord {
    readonly paints: readonly Paint[];
    readonly lcp: readonly LargestPaint[];
    readonly longTasks: readonly LongTask[];
    readonly shifts: readonly Shift[];
    readonly events: readonly EventTiming[];
    readonly frames: readonly Frame[];
}

/** The same lists as the page fills them. */
export type Gathering = { -readonly [Key in keyof PageRecord]: PageRecord[Key][number][] };

declare global {
    interface Window {
        perfMobile?: Gathering;
        /** Frame intervals a scenario samples while it scrolls. */
        perfFrames?: number[];
    }
}

// Two entry types newer than the DOM typings: a layout shift, and a long animation frame with its scripts.
interface ShiftEntry extends PerformanceEntry {
    readonly value: number;
    readonly hadRecentInput: boolean;
    readonly sources: readonly { readonly node: Node | null; readonly previousRect: DOMRectReadOnly; readonly currentRect: DOMRectReadOnly }[];
}

interface ScriptEntry {
    readonly duration: number;
    readonly sourceURL: string;
    readonly sourceFunctionName: string;
    readonly invoker: string;
    readonly invokerType: string;
}

interface FrameEntry extends PerformanceEntry {
    readonly styleAndLayoutStart: number;
    readonly scripts: readonly ScriptEntry[];
}

/**
 * Web vitals and long frames, observed from the first byte: paints, LCP, long tasks, layout shifts with the nodes that
 * moved, event timings (every interaction's input delay, processing and presentation, which is what INP is made of)
 * and long animation frames with the scripts that ran in them.
 */
export function observePerformance(): void {
    const describe = (node: Node | null | undefined): string => {
        if (!(node instanceof Element)) {
            return node?.nodeName ?? `none`;
        }
        const classes = [...node.classList].slice(0, 4).join(`.`);
        return `${node.localName}${node.id === `` ? `` : `#${node.id}`}${classes === `` ? `` : `.${classes}`}`;
    };
    const record: Gathering = { paints: [], lcp: [], longTasks: [], shifts: [], events: [], frames: [] };
    window.perfMobile = record;
    const observe = <Entry extends PerformanceEntry>(type: string, is: (entry: PerformanceEntry) => entry is Entry, each: (entry: Entry) => void): void => {
        // Event timing reports only events at least this long; 16ms is the least it accepts.
        const init = { type, buffered: true, durationThreshold: 16 };
        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (is(entry)) {
                        each(entry);
                    }
                }
            }).observe(init);
        } catch {
            // An entry type this browser does not have records nothing.
        }
    };
    const any = (entry: PerformanceEntry): entry is PerformanceEntry => entry.duration >= 0;
    const isShift = (entry: PerformanceEntry): entry is ShiftEntry => entry.entryType === `layout-shift` && `sources` in entry;
    const isFrame = (entry: PerformanceEntry): entry is FrameEntry => entry.entryType === `long-animation-frame` && `scripts` in entry;
    const isEvent = (entry: PerformanceEntry): entry is PerformanceEventTiming => entry instanceof PerformanceEventTiming;
    const isLargest = (entry: PerformanceEntry): entry is LargestContentfulPaint => entry instanceof LargestContentfulPaint;
    const box = (rect: DOMRectReadOnly): string => [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(`,`);
    const scriptLine = (script: ScriptEntry): string => {
        const file = script.sourceURL.split(`/`).pop()?.split(`?`)[0] ?? ``;
        const where = [file, script.sourceFunctionName].filter((part) => part !== ``).join(`:`) || script.invokerType;
        return `${where} (${script.invoker.slice(0, 40)}) ${Math.round(script.duration)}ms`;
    };
    observe(`paint`, any, (entry) => record.paints.push({ name: entry.name, start: Math.round(entry.startTime) }));
    observe(`largest-contentful-paint`, isLargest, (entry) => record.lcp.push({ start: Math.round(entry.startTime), element: describe(entry.element) }));
    observe(`longtask`, any, (entry) => record.longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) }));
    observe(`layout-shift`, isShift, (entry) =>
        record.shifts.push({
            start: Math.round(entry.startTime),
            value: entry.value,
            recentInput: entry.hadRecentInput,
            sources: entry.sources.slice(0, 3).map((source) => `${describe(source.node)} ${box(source.previousRect)} → ${box(source.currentRect)}`),
        }),
    );
    observe(`event`, isEvent, (entry) =>
        record.events.push({
            name: entry.name,
            interaction: entry.interactionId,
            start: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
            inputDelay: Math.round(entry.processingStart - entry.startTime),
            processing: Math.round(entry.processingEnd - entry.processingStart),
            presentation: Math.round(entry.startTime + entry.duration - entry.processingEnd),
            target: describe(entry.target),
        }),
    );
    observe(`long-animation-frame`, isFrame, (entry) => {
        const end = entry.startTime + entry.duration;
        record.frames.push({
            start: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
            styleLayout: entry.styleAndLayoutStart > 0 ? Math.round(end - entry.styleAndLayoutStart) : 0,
            scripts: entry.scripts
                .toSorted((a, b) => b.duration - a.duration)
                .slice(0, 4)
                .map(scriptLine),
        });
    });
}

// The fields of a transcript row the inflation rewrites; every other field is copied as it came.
interface TranscriptRow {
    readonly role?: string;
    text?: string;
    tools?: readonly { readonly id: string }[];
}

interface Transcript {
    readonly messages: readonly TranscriptRow[];
}

/**
 * Inflates one fixture conversation's transcript to `copies` copies of its rows, standing in for a long real run: the
 * demo's own conversations are a handful of turns. Wraps `fetch` once the demo has installed its own, which is how the
 * demo's daemon answers (`_site/demo/src/transport.ts`). Every second copy of an answer gains a list, a table and a
 * TypeScript block, so markdown and highlighting are exercised as an agent's answers would.
 */
export function inflateTranscript(ask: { readonly conversationId: string; readonly copies: number }): void {
    const addition = (index: number): string =>
        [
            ``,
            `What changed in step ${index}:`,
            ``,
            "- The `users` table gains `deleted_at`, nullable.",
            "- Every read goes through `liveUsers()`.",
            ``,
            `| file | change |`,
            `| --- | --- |`,
            `| schema.ts | +3 |`,
            ``,
            "```ts",
            `export const liveUsers = () => db.select().from(users).where(isNull(users.deletedAt));`,
            `export const retire = async (id: string) => {`,
            `    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));`,
            `};`,
            "```",
            ``,
        ].join(`\n`);
    const wrap = (): void => {
        const answer = globalThis.fetch;
        const inflated = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = input instanceof Request ? input.url : String(input);
            const response = await answer(input, init);
            if (!url.includes(`demo.invalid/agents/${ask.conversationId}/transcript`)) {
                return response;
            }
            const body: Transcript = await response.json();
            const rows: TranscriptRow[] = [];
            for (let copy = 0; copy < ask.copies; copy += 1) {
                for (const row of body.messages) {
                    const next = structuredClone(row);
                    if (next.tools !== undefined) {
                        next.tools = next.tools.map((tool) => ({ ...tool, id: `${tool.id}_${copy}` }));
                    }
                    if (next.role === `assistant` && next.text !== undefined && copy % 2 === 0) {
                        next.text = `${next.text}${addition(copy)}`;
                    }
                    rows.push(next);
                }
            }
            return new Response(JSON.stringify({ ...body, messages: rows }), { status: 200, headers: { "content-type": `application/json` } });
        };
        globalThis.fetch = Object.assign(inflated, { preconnect: () => undefined });
    };
    // The demo installs its own fetch as it boots; this one goes over it, the moment it has.
    const waiting = setInterval(() => {
        if (!String(globalThis.fetch).includes(`[native code]`)) {
            clearInterval(waiting);
            wrap();
        }
    }, 2);
}

/**
 * Points the app's analytics at this server's stand-in for PostHog (`wire.ts`), so the real SDK and its session
 * recorder run as they do in production. The demo's own `window.env` switches analytics off.
 */
export function enableAnalytics(): void {
    let env: { analytics?: unknown } | undefined;
    Object.defineProperty(window, `env`, {
        configurable: true,
        get: () => env,
        set: (value: { analytics?: unknown }) => {
            env = value;
            if (value !== undefined && value.analytics !== undefined) {
                value.analytics = { posthogKey: `phc_perf_mobile`, posthogHost: `${location.origin}/wire` };
            }
        },
    });
}
