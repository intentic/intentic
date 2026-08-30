import type { IssueReport } from "@intentic/sandbox-contract";

/* CATCHING WHAT THE PAGE DID NOT.
 *
 * Two handlers, which between them are every uncaught failure a browser will tell you about:
 *
 *   error               a synchronous throw that reached the top, and (with `capture: true`) a resource that
 *                       failed to load. The second is filtered out below: a 404 on an image is not a crash.
 *   unhandledrejection  a promise nobody caught, which in an async codebase is most of them.
 *
 * ADDED, NEVER ASSIGNED. `window.onerror = …` is a single slot: assigning it silently unhooks whatever the site
 * (or its analytics, or its framework) had there, and the failure mode is somebody else's error reporting going
 * quiet weeks later with nothing pointing here. addEventListener composes; this one has to.
 *
 * NOTHING IS PREVENTED. The handlers observe and return; the page's own error handling sees exactly what it
 * would have seen with this script absent. */

export interface Capture {
    readonly detach: () => void;
}

/* A failed <img>/<script>/<link> arrives on the same `error` event as a real throw. Reporting those would fill
 * the inbox with other people's CDNs, so they are told apart by their two marks: no `error` object, and an
 * ELEMENT as the target (a script-level error's target is the window).
 *
 * BOTH null AND undefined, and the distinction is not pedantry: the DOM specifies `ErrorEvent.error` as `null`
 * when absent, so an `=== undefined` check (which is what this was) let every broken image through as a crash
 * whose message was the string "null".
 *
 * `instanceof Element` rather than `target !== window`, which is what this tried first and which is subtly
 * wrong: `window` is not one object everywhere it is written. A jsdom global is a proxy that fails an identity
 * check against the Window the event carries, and an error inside an iframe carries that frame's window, not
 * this one. Asking what the target IS holds in every realm; asking what it is not held in neither. */
const absent = (value: unknown): boolean => value === null || value === undefined;
const isResourceError = (event: ErrorEvent): boolean => absent(event.error) && event.target instanceof Element;

/* An unknown throw as a report. `catch` receives anything a `throw` can carry, which is anything at all: the
 * string case and the plain-object case are both common in the wild (a rejected fetch wrapper, a framework
 * throwing a config bag) and neither has a stack. Whatever arrives gets a readable message so it still groups
 * on something rather than on the word "undefined". */
export const reportFrom = (value: unknown, kind: "crash" = "crash"): IssueReport => {
    if (value instanceof Error) {
        return {
            kind,
            message: `${value.name}: ${value.message}`,
            ...(typeof value.stack === "string" ? { stack: value.stack } : {}),
        };
    }
    if (typeof value === "string") {
        return { kind, message: value };
    }
    /* `throw null` and a promise rejected with `undefined` are both real and both stringify to something
     * useless: JSON.stringify(null) is the string "null", which would group every one of them together under a
     * message that says nothing. Named for what happened instead. */
    if (absent(value)) {
        return { kind, message: `Non-error thrown (${String(value)})` };
    }
    try {
        return { kind, message: JSON.stringify(value) ?? String(value) };
    } catch {
        return { kind, message: `Non-error thrown (${typeof value})` };
    }
};

export const startCapture = (onCrash: (report: IssueReport) => void): Capture => {
    const onError = (event: ErrorEvent): void => {
        if (isResourceError(event)) {
            return;
        }
        /* `event.error` is the real Error when there is one. When there is not, this is the cross-origin case:
         * a script served from another origin without `crossorigin` gives "Script error." and nothing else, by
         * design, in every browser. It is still reported, because the daemon groups a stackless crash by the
         * PAGE, so it arrives as "something on /checkout is throwing and we cannot see what" — which is
         * actionable (add crossorigin to that tag) where silence is not. */
        onCrash(absent(event.error) ? { kind: "crash", message: event.message || "Script error." } : reportFrom(event.error));
    };

    const onRejection = (event: PromiseRejectionEvent): void => onCrash(reportFrom(event.reason));

    // `capture: true` on error so a listener the page added first cannot stop this one being reached, which is
    // the arrangement most likely to exist on exactly the pages worth hearing from.
    window.addEventListener("error", onError, { capture: true });
    window.addEventListener("unhandledrejection", onRejection);

    return {
        detach: () => {
            window.removeEventListener("error", onError, { capture: true });
            window.removeEventListener("unhandledrejection", onRejection);
        },
    };
};
