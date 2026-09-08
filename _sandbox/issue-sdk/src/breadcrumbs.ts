import type { IssueBreadcrumb } from "@intentic/sandbox-contract";

// What happened before a crash, kept as a bounded ring buffer (count and per-message length capped) since this patches
// globals on someone else's page. Not instrumented:
// - request bodies and keystrokes (passwords, personal data)
// - console.log (only warn/error are recorded)

const MAX = 40;
const MESSAGE_MAX = 300;

export interface Breadcrumbs {
    readonly add: (kind: string, message: string) => void;
    readonly all: () => IssueBreadcrumb[];
    // Undoes every patch to the page's globals, so a test's console patch is not still live in the next.
    readonly detach: () => void;
}

const trim = (message: string): string => (message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX - 1)}…` : message);

// A console argument as a short string; errors keep their message, and anything that won't stringify becomes its type
// instead of throwing.
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

    // Wraps rather than replaces: the original runs first and its return value passes through, so a page with its own
    // console instrumentation keeps working.
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

    // Only failures are recorded, since a working app's successes would push the meaningful event out of the ring. A
    // network error is recorded and re-thrown untouched.
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

    // `popstate` covers back/forward; `pushState`/`replaceState` are wrapped since an SPA route change fires no event
    // of its own.
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

    // The element only, as a short label (tag, id, accessible name), never its contents. Captured in the capture phase
    // so it's recorded even if the app's handler stops propagation.
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
            // Unwound in reverse, so a wrap over another wrap is removed from the outside in.
            for (const step of undo.toReversed()) {
                step();
            }
            undo.length = 0;
        },
    };
};

// A URL as its path only; the query is where ids and tokens live.
const pathOnly = (target: string): string => {
    try {
        return new URL(target, location.href).pathname;
    } catch {
        return target;
    }
};

// An element as a short label: `button#checkout "Pay now"`. The name comes from the element's own label, bounded, not
// its subtree text.
const LABEL_MAX = 40;
const describe = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const id = element.id === "" ? "" : `#${element.id}`;
    const label = (element.getAttribute("aria-label") ?? element.getAttribute("name") ?? "").trim();
    return `${tag}${id}${label === "" ? "" : ` "${label.slice(0, LABEL_MAX)}"`}`;
};
