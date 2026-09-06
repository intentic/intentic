import type { IssueBreadcrumb } from "@intentic/sandbox-contract";

/* WHAT HAPPENED IN THE SECONDS BEFORE, which is usually how a crash turns into steps to reproduce. A stack says
 * where it broke; breadcrumbs say what the person did to get there, and only one of those can be worked out
 * from the source afterwards.
 *
 * A RING BUFFER, NOT A LOG. Bounded at both ends: how many are kept and how long each may be. This runs on
 * somebody else's product, in front of every click, so unbounded memory here is a leak in a customer's page.
 *
 * WHAT IS DELIBERATELY NOT INSTRUMENTED, since the omissions are the interesting part:
 *   - request BODIES. A failed request records its method, its path and its status, never what was in it. That
 *     is where the passwords and the personal data are, and a bug reporter that quietly shipped them off the
 *     page would be the worst thing in this repository.
 *   - keystrokes. The same argument, one step more obviously.
 *   - console.log. Only warnings and errors: a chatty app would otherwise fill the whole ring with noise before
 *     the crash it is supposed to explain.
 */

const MAX = 40;
const MESSAGE_MAX = 300;

export interface Breadcrumbs {
    readonly add: (kind: string, message: string) => void;
    readonly all: () => IssueBreadcrumb[];
    // Undo every patch this made to the page's globals. What `stop()` on the client calls, and what a test
    // needs so one case's console patch is not still live in the next.
    readonly detach: () => void;
}

const trim = (message: string): string => (message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX - 1)}…` : message);

// One argument of a console call, as a short string. Errors keep their message, objects their shape; anything
// that will not stringify (a proxy, a cyclic graph) becomes its type rather than throwing inside a console call
// the page made for its own reasons.
const readable = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }
    if (value instanceof Error) {
        return `${value.name}: ${value.message}`;
    }
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return typeof value;
    }
};

export const createBreadcrumbs = (): Breadcrumbs => {
    const ring: IssueBreadcrumb[] = [];
    const undo: Array<() => void> = [];

    const add = (kind: string, message: string): void => {
        ring.push({ at: Date.now(), kind, message: trim(message) });
        if (ring.length > MAX) {
            ring.shift();
        }
    };

    /* ---- console.warn / console.error ----
     *
     * Patched by WRAPPING rather than replacing: the original is called first and its return value passed
     * through, so a page that has its own console instrumentation (most analytics products do) keeps working,
     * and ours can be removed later without stranding theirs. */
    for (const level of ["warn", "error"] as const) {
        const original = console[level];
        console[level] = (...args: unknown[]) => {
            add(`console.${level}`, args.map(readable).join(" "));
            original.apply(console, args);
        };
        undo.push(() => {
            console[level] = original;
        });
    }

    /* ---- failed requests ----
     *
     * Only the failures. A working app makes hundreds of successful requests a minute and every one of them
     * would push the click that actually mattered out of the ring; a 500 twelve seconds before a crash is the
     * whole story. A network error (offline, CORS, DNS) is recorded and then RE-THROWN untouched: the page's own
     * error handling must see exactly what it would have seen. */
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const method = init?.method ?? (input instanceof Request ? input.method : "GET");
            const target = input instanceof Request ? input.url : String(input);
            try {
                const response = await originalFetch(input, init);
                if (!response.ok) {
                    add("fetch", `${method} ${pathOnly(target)} → ${response.status}`);
                }
                return response;
            } catch (error) {
                add("fetch", `${method} ${pathOnly(target)} → ${error instanceof Error ? error.message : "network error"}`);
                throw error;
            }
        };
        undo.push(() => {
            window.fetch = originalFetch;
        });
    }

    /* ---- navigation ----
     *
     * `popstate` covers back/forward. `pushState`/`replaceState` are wrapped because a single-page app changes
     * route without firing any event at all, and "which screen were they on" is the first thing anybody asks. */
    const onPop = (): void => add("navigation", location.pathname + location.search);
    window.addEventListener("popstate", onPop);
    undo.push(() => window.removeEventListener("popstate", onPop));

    for (const method of ["pushState", "replaceState"] as const) {
        const original = history[method];
        history[method] = function patched(this: History, ...args: Parameters<History["pushState"]>) {
            const result = original.apply(this, args);
            add("navigation", location.pathname + location.search);
            return result;
        };
        undo.push(() => {
            history[method] = original;
        });
    }

    /* ---- clicks ----
     *
     * The element, never its contents: a selector-ish label built from the tag, its id and its accessible name.
     * `capture: true` so a click is recorded even when the app's own handler stops propagation, which is exactly
     * the handler most likely to be the one that then threw. */
    const onClick = (event: MouseEvent): void => {
        const target = event.target;
        if (target instanceof Element) {
            add("click", describe(target));
        }
    };
    window.addEventListener("click", onClick, { capture: true });
    undo.push(() => window.removeEventListener("click", onClick, { capture: true }));

    return {
        add,
        all: () => [...ring],
        detach: () => {
            // Unwound in reverse, so a global we wrapped over somebody else's wrapper is unwrapped from the
            // outside in and the page's own instrumentation is left exactly as we found it.
            for (const step of undo.toReversed()) {
                step();
            }
            undo.length = 0;
        },
    };
};

// A URL as its path: the host is on every line already and the query is where the ids and the tokens live.
const pathOnly = (target: string): string => {
    try {
        return new URL(target, location.href).pathname;
    } catch {
        return target;
    }
};

/* An element as something a developer can find again: `button#checkout "Pay now"`. The accessible name is
 * bounded hard and taken from the element's own label rather than its subtree text, since a click on a card
 * would otherwise drag a paragraph of the page's content into a breadcrumb. */
const LABEL_MAX = 40;
const describe = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const id = element.id === "" ? "" : `#${element.id}`;
    const label = (element.getAttribute("aria-label") ?? element.getAttribute("name") ?? "").trim();
    return `${tag}${id}${label === "" ? "" : ` "${label.slice(0, LABEL_MAX)}"`}`;
};
