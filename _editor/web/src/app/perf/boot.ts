import { recordPerf } from "./perf";

// HOW LONG A PAGE LOAD TOOK, AND WHICH PART OF IT. A reload is a chain the reader waits through end to end: the bundle,
// main.ts, the language, the platform's session, the cache read back from IndexedDB, the sandbox list, the shell's chunk
// and then the view's. Each link is marked once, the first time it is reached in this page, and the load is filed as one
// `boot` span when the first view has drawn: its milliseconds from the browser's navigation start, its fields each
// link's offset on the same clock. Slow loads reach the daemon's client log like any slow span (perf.ts, budget 2.5 s),
// every load is in `__intenticPerf.dump('boot')`, and each link is a `performance.mark` a DevTools trace shows in place.

export type BootLink = `main` | `i18n` | `mount` | `session` | `restore` | `list` | `guards` | `shell` | `view`;

const reached = new Map<BootLink, number>();
let filed = false;

const mark = (link: BootLink): void => {
    reached.set(link, performance.now());
    try {
        performance.mark(`boot:${link}`);
    } catch {
        // allow(silent-catch): a browser without User Timing still gets the span; the marks are for traces only.
    }
};

/** Marks a link of the start the first time this page reaches it; a later reach (a re-navigation) is not the start. */
export const markBoot = (link: BootLink): void => {
    if (!filed && !reached.has(link)) {
        mark(link);
    }
};

// What the page itself downloaded to start: near zero on a reload served from cache, the whole bundle on a hard reload or
// a first visit. That is what tells a slow hard reload from a slow ordinary one in the log.
// Each timing kind only where the browser has it: a webview or test runtime without one reads as nothing downloaded.
const timingKinds = `PerformanceResourceTiming` in globalThis && `PerformanceNavigationTiming` in globalThis;

const transferKB = (): number => {
    if (!timingKinds) {
        return 0;
    }
    let bytes = 0;
    for (const entry of performance.getEntriesByType(`resource`)) {
        if (entry instanceof PerformanceResourceTiming) {
            bytes += entry.transferSize;
        }
    }
    const navigation = performance.getEntriesByType(`navigation`)[0];
    if (navigation instanceof PerformanceNavigationTiming) {
        bytes += navigation.transferSize;
    }
    return Math.round(bytes / 1024);
};

const navigationType = (): string => {
    if (!timingKinds) {
        return `unknown`;
    }
    const navigation = performance.getEntriesByType(`navigation`)[0];
    return navigation instanceof PerformanceNavigationTiming ? navigation.type : `unknown`;
};

// After the frame the caller rendered in has been presented: the next animation frame, then a task after it. A hidden
// page presents no frames, so there it is now. (lib/afterPaint.ts says the same, but lib sits on this module's other side.)
const afterFrame = (then: () => void): void => {
    if (`requestAnimationFrame` in globalThis && `document` in globalThis && document.visibilityState !== `hidden`) {
        requestAnimationFrame(() => setTimeout(then, 0));
    } else {
        then();
    }
};

/**
 * Files the load once its first view has drawn: called by whatever draws first (a shell view, or a page outside the
 * shell), and timed after the frame it rendered in, so the span ends where the reader sees something.
 */
export const finishBoot = (route: string): void => {
    if (filed) {
        return;
    }
    filed = true;
    afterFrame(() => {
        mark(`view`);
        const links = Object.fromEntries([...reached].map(([link, at]) => [link, Math.round(at)]));
        recordPerf(`boot`, links[`view`] ?? 0, { route, nav: navigationType(), transferKB: transferKB(), ...links });
    });
};
