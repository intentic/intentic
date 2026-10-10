import type { Directive } from "vue";
import { takeImprint } from "./skeletonImprint.js";
import { rememberImprint, skeletonScope } from "./skeletonStore.js";

// `v-skeleton-source="name"` on the element a loading placeholder stands in for: once that element has settled (no
// resize and no change inside it for a moment, then idle time), what it shows is taken as `name`'s imprint in the
// current scope, for the `<SkeletonSnapshot of="name">` drawn there next time. A later resize or change (rows arriving,
// an editor filling a pane of fixed size, a reply streaming in) takes it again once things are quiet. The name may
// carry a variant (`diff:${path}`); changing it re-arms the capture under the new one.

// Long enough for a list to finish arriving and its reveal to play; short enough that a quick visit still counts.
const SETTLE_MS = 500;
const IDLE_TIMEOUT_MS = 2_000;

interface Source {
    name: string | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
    idle: number | undefined;
    /** What the observer watches: the element, or its parent when the element is `display: contents` and has no box. */
    readonly watched: Element;
    /** Changes inside the element that leave its size alone: a pane of fixed size whose content arrives late. */
    readonly changes: MutationObserver | undefined;
}

const sources = new WeakMap<Element, Source>();
// The sources each watched element stands for: usually itself, or the boxless sources inside it.
const watchers = new WeakMap<Element, Set<Element>>();

const cancel = (source: Source): void => {
    clearTimeout(source.timer);
    source.timer = undefined;
    if (source.idle !== undefined && `cancelIdleCallback` in globalThis) {
        cancelIdleCallback(source.idle);
    }
    source.idle = undefined;
};

const capture = (element: Element, source: Source, scope: string): void => {
    source.idle = undefined;
    const name = source.name;
    // A scope that changed while this waited has already redrawn the element for another sandbox, or is about to.
    if (name === undefined || name === `` || scope !== skeletonScope()) {
        return;
    }
    const imprint = takeImprint(element);
    if (imprint !== undefined) {
        rememberImprint(scope, name, imprint);
    }
};

const schedule = (element: Element): void => {
    const source = sources.get(element);
    if (source === undefined) {
        return;
    }
    cancel(source);
    const scope = skeletonScope();
    source.timer = setTimeout(() => {
        source.timer = undefined;
        if (`requestIdleCallback` in globalThis) {
            source.idle = requestIdleCallback(() => capture(element, source, scope), { timeout: IDLE_TIMEOUT_MS });
            return;
        }
        capture(element, source, scope);
    }, SETTLE_MS);
};

// One observer for every source on the page. Its first report for an element is that element's size on observe, so
// a view that never resizes is still captured once.
let observer: ResizeObserver | undefined;
const observing = (): ResizeObserver | undefined => {
    if (observer === undefined && `ResizeObserver` in globalThis) {
        observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                for (const element of watchers.get(entry.target) ?? []) {
                    schedule(element);
                }
            }
        });
    }
    return observer;
};

export const vSkeletonSource: Directive<HTMLElement, string | undefined> = {
    mounted(element, { value }) {
        const watched = getComputedStyle(element).display === `contents` ? (element.parentElement ?? element) : element;
        const changes = `MutationObserver` in globalThis ? new MutationObserver(() => schedule(element)) : undefined;
        changes?.observe(element, { childList: true, subtree: true, characterData: true });
        sources.set(element, { name: value, timer: undefined, idle: undefined, watched, changes });
        const watcher = observing();
        if (watcher === undefined) {
            schedule(element);
            return;
        }
        const standing = watchers.get(watched) ?? new Set();
        standing.add(element);
        watchers.set(watched, standing);
        watcher.observe(watched);
    },
    updated(element, { value, oldValue }) {
        const source = sources.get(element);
        if (source === undefined || value === oldValue) {
            return;
        }
        source.name = value;
        schedule(element);
    },
    beforeUnmount(element) {
        const source = sources.get(element);
        if (source === undefined) {
            return;
        }
        cancel(source);
        source.changes?.disconnect();
        sources.delete(element);
        const standing = watchers.get(source.watched);
        standing?.delete(element);
        if (standing?.size === 0) {
            watchers.delete(source.watched);
            observer?.unobserve(source.watched);
        }
    },
};
