// Each helper is nested inside the function that uses it, since executeScript serializes and re-parses that function
// inside the page, where nothing else in this module exists (an imported `sleep` once threw there on the first look
// that missed, and wait_for read the empty answer as a crash: "Cannot read properties of null").

// wait_for, inside the tab. The worker (background/tools/page.ts) installs a watch once (watchPage), then injects short
// rounds (waitRound) until the conditions hold or its deadline passes. Rounds are short so that no single executeScript
// call stays open for minutes, which an MV3 worker is not promised to survive; the watch outlives each round on the
// isolated world's window, so a page that went still in the middle of one round is still at the start of the next, and
// a round that finds no watch knows the document it was installed in has been replaced.
//
// Built for a throttled page (the agent's window behind the person's: no animation frames, timers about once a
// second): the MutationObserver hears every change as it happens, and timers only end a round and mark when a quiet
// stretch will be complete, so a late timer delays an answer by the throttle's second, never misses one. Nothing here
// uses requestAnimationFrame, which a covered window never runs.

// What wait_for waits on. Every condition given must hold at the same moment: `text` on the page, `textGone` off it,
// and the page unchanged for `quietMs`. Undefined is a condition not asked.
export interface WaitConditions {
    readonly text: string | undefined;
    readonly textGone: string | undefined;
    readonly quietMs: number | undefined;
}

// Where a wait stands at the end of a round. `replaced`: the document is not the one the watch was installed in, so the
// page navigated and its watch went with it. `busy` names what kept the page from being still, busiest first, and is
// filled in only while `quietMs` is unmet.
export interface WaitRound {
    readonly state: "met" | "waiting" | "replaced";
    readonly url: string;
    // Whether `text` is on the page now, and whether `textGone` still is; null for a condition not asked.
    readonly textShown: boolean | null;
    readonly textGoneShown: boolean | null;
    readonly stillMs: number;
    readonly longestStillMs: number;
    readonly busy: readonly string[];
}

// One wait's watch over a document, on the isolated world's window between rounds.
interface PageWatch {
    lastChange: number;
    longestStill: number;
    // What kept changing lately, described for an agent, busiest first.
    readonly busy: (now: number) => string[];
    readonly stop: () => void;
    // The running round's ear, while one runs.
    onChange: (() => void) | undefined;
    // Stops a watch whose next round never came (the worker died, the call was dropped).
    abandon: ReturnType<typeof setTimeout> | undefined;
}

// What the worker learns from installing a watch: the page it watches.
export interface WatchStarted {
    readonly url: string;
}

declare global {
    interface Window {
        intenticWatches?: Record<string, PageWatch>;
    }
}

// Starts watching the page for wait `id`: every change to children, text and attributes, except the extension's own
// banner and question (page/overlay.ts), which it draws itself, and the document's <head> other than its title, where
// scripts and styles come and go with nothing a person sees. Changes are counted per element so a wait that never saw
// the page still can name what kept it busy.
// That is the whole rule for "quiet": nothing changed, with no guessing at which changes matter. A CSS animation (most
// spinners, ChatGPT's shimmering "Thinking") is not a DOM change at all, so it never breaks a quiet stretch; a clock, a
// counter or a streaming answer that rewrites its text does, every time, and is named, so the agent can wait for text
// instead. Ignoring "steady rhythms" was considered and left out: a progress bar ticking along is exactly a steady
// rhythm, and calling that quiet would answer before the work is done.
export const watchPage = (id: string): WatchStarted => {
    // How far back `busy` looks, and how long an element's count is kept after it last changed.
    const BUSY_WINDOW_MS = 60_000;
    // Elements counted at once: a page rebuilding thousands of nodes needs naming no more precisely than its first few hundred.
    const BUSY_LIMIT = 500;
    // As waitRound's: how long a watch waits for a round before stopping itself.
    const ABANDON_MS = 60_000;
    const watches = (window.intenticWatches ??= {});
    const changes = new Map<Element, { count: number; since: number; last: number; readonly kinds: Set<string> }>();

    const ours = (node: Node): boolean => node instanceof Element && (node.id === "intentic-agent-banner" || node.hasAttribute("data-intentic-ask"));
    // The element a mutation is about, or nothing when it is one that does not count.
    const counted = (record: MutationRecord): Element | undefined => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target === null || ours(target)) {
            return undefined;
        }
        const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
        if (record.type === "childList" && nodes.length > 0 && nodes.every(ours)) {
            return undefined;
        }
        return document.head?.contains(target) === true && target.closest("title") === null ? undefined : target;
    };
    // An element as an agent can recognise it in a snapshot: tag, id, a class or two, role, and what it says.
    const describe = (el: Element): string => {
        const hash = el.id === "" ? "" : `#${el.id}`;
        const classes = Array.from(el.classList)
            .slice(0, 2)
            .map((name) => `.${name}`)
            .join("");
        const role = el.getAttribute("role");
        const tag = `${el.tagName.toLowerCase()}${hash}${classes}`.slice(0, 60) + (role === null ? "" : `[role=${role}]`);
        // SAFETY: innerText is read only where the element has it; jsdom and SVG elements fall through to textContent.
        const shown = (el as Partial<HTMLElement>).innerText ?? el.textContent ?? "";
        const said = (el.getAttribute("aria-label") ?? shown).trim().replace(/\s+/g, " ").slice(0, 40);
        return said === "" ? tag : `${tag} "${said}"`;
    };
    const kindOf = (record: MutationRecord): string =>
        record.type === "attributes" ? `attribute ${record.attributeName ?? ""}`.trim() : record.type === "characterData" ? "text" : "children";
    const note = (el: Element, kind: string, now: number): void => {
        const entry = changes.get(el);
        if (entry !== undefined) {
            entry.count += 1;
            entry.last = now;
            entry.kinds.add(kind);
        } else if (changes.size < BUSY_LIMIT) {
            changes.set(el, { count: 1, since: now, last: now, kinds: new Set([kind]) });
        }
    };

    const started = Date.now();
    const observer = new MutationObserver((records) => {
        const now = Date.now();
        let changed = false;
        for (const record of records) {
            const el = counted(record);
            if (el !== undefined) {
                changed = true;
                note(el, kindOf(record), now);
            }
        }
        if (changed) {
            watch.longestStill = Math.max(watch.longestStill, now - watch.lastChange);
            watch.lastChange = now;
            watch.onChange?.();
        }
    });
    const watch: PageWatch = {
        lastChange: started,
        longestStill: 0,
        busy: (now) => {
            for (const [el, entry] of changes) {
                if (now - entry.last > BUSY_WINDOW_MS) {
                    changes.delete(el);
                }
            }
            return Array.from(changes.entries())
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, 3)
                .map(([el, entry]) => {
                    const over = Math.max(1, Math.round((now - entry.since) / 1000));
                    return `${describe(el)}: ${entry.count} change${entry.count === 1 ? "" : "s"} in the last ${over} s (${Array.from(entry.kinds).join(", ")})`;
                });
        },
        stop: () => {
            observer.disconnect();
            clearTimeout(watch.abandon);
            if (watches[id] === watch) {
                delete watches[id];
            }
        },
        onChange: undefined,
        abandon: undefined,
    };
    watches[id] = watch;
    // Until its first round takes it over: a worker that dies before asking must not leave the observer running.
    watch.abandon = setTimeout(watch.stop, ABANDON_MS);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    return { url: location.href };
};

// One round of wait `id`: answers as soon as every condition holds, or after `roundMs` with where things stand. The
// watch is stopped once the wait is met or this is its `last` round; otherwise it is left for the next round, and stops
// itself if none comes. Text is read (innerText, which forces a layout) only after a burst of changes, at most once per
// LOOK_GAP_MS, never on a timer of its own: a page doing nothing is not read again.
export const waitRound = async (id: string, conditions: WaitConditions, roundMs: number, last: boolean): Promise<WaitRound> => {
    const LOOK_GAP_MS = 50;
    const ABANDON_MS = 60_000;
    const watch = window.intenticWatches?.[id];
    if (watch === undefined) {
        return { state: "replaced", url: location.href, textShown: null, textGoneShown: null, stillMs: 0, longestStillMs: 0, busy: [] };
    }
    clearTimeout(watch.abandon);
    const { text: needle, textGone, quietMs } = conditions;
    const report = (): WaitRound => {
        const now = Date.now();
        const text = needle === undefined && textGone === undefined ? "" : (document.body?.innerText ?? document.body?.textContent ?? "");
        const stillMs = now - watch.lastChange;
        const quiet = quietMs === undefined || stillMs >= quietMs;
        const textShown = needle === undefined ? null : text.includes(needle);
        const textGoneShown = textGone === undefined ? null : text.includes(textGone);
        return {
            state: textShown !== false && textGoneShown !== true && quiet ? "met" : "waiting",
            url: location.href,
            textShown,
            textGoneShown,
            stillMs,
            longestStillMs: Math.max(watch.longestStill, stillMs),
            busy: quiet ? [] : watch.busy(now),
        };
    };
    return await new Promise<WaitRound>((resolve) => {
        let look: ReturnType<typeof setTimeout> | undefined;
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const end = (answer: WaitRound): void => {
            clearTimeout(look);
            clearTimeout(quiet);
            clearTimeout(cap);
            // A round the worker gave up on (its page frozen, then thawed) can end after a newer one took the watch over.
            // That one owns the watch now: this one only answers, to nobody, and neither stops the watch nor leaves a
            // timer that would stop it under the newer round, after which the page would read as quiet.
            if (watch.onChange === ear) {
                watch.onChange = undefined;
                if (answer.state === "met" || last) {
                    watch.stop();
                } else {
                    watch.abandon = setTimeout(watch.stop, ABANDON_MS);
                }
            }
            resolve(answer);
        };
        // Looks at the page, and otherwise marks the moment it will have been still long enough, unless it changes first.
        const check = (): void => {
            look = undefined;
            const answer = report();
            if (answer.state === "met") {
                end(answer);
            } else if (quietMs !== undefined && answer.stillMs < quietMs) {
                // Only while the quiet stretch is still short: once it holds and only text is missing, nothing is due
                // until the page changes again, and a mark at zero would re-read the page on every timer tick.
                clearTimeout(quiet);
                quiet = setTimeout(check, Math.max(0, watch.lastChange + quietMs - Date.now()));
            }
        };
        const ear = (): void => {
            look ??= setTimeout(check, LOOK_GAP_MS);
        };
        watch.onChange = ear;
        // Declared before the first check, which may end the round at once and clears it.
        const cap = setTimeout(() => end(report()), Math.max(0, roundMs));
        check();
    });
};
