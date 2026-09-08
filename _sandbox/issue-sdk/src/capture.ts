import type { IssueReport } from "@intentic/sandbox-contract";

// Every uncaught failure a browser reports, via two handlers:
// - error: a throw that reached the top, or (filtered out) a failed resource load
// - unhandledrejection: a promise nobody caught
// Added via addEventListener, not assigned to `window.onerror`: assigning would unhook the site's own handler. Observes
// only, never prevents.

export interface Capture {
    readonly detach: () => void;
}

// A resource error has no `event.error` (DOM gives `null`, not `undefined`) and a target that IS an Element; `target
// !== window` fails across realms (iframes, jsdom's proxy).
const absent = (value: unknown): boolean => value === null || value === undefined;
const isResourceError = (event: ErrorEvent): boolean => absent(event.error) && event.target instanceof Element;

// An unknown throw as a report; `catch` can receive anything (a string, a plain object, no stack), so whatever arrives
// gets a readable message rather than grouping under "undefined".
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
    // `null`/`undefined` both stringify to the unhelpful "null"; named for what happened instead.
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
        // A cross-origin script gives only "Script error."; still reported, since a crash still names the page.
        onCrash(absent(event.error) ? { kind: "crash", message: event.message || "Script error." } : reportFrom(event.error));
    };

    const onRejection = (event: PromiseRejectionEvent): void => onCrash(reportFrom(event.reason));

    // `capture: true` so a listener the page added first cannot stop this one from seeing the error.
    window.addEventListener("error", onError, { capture: true });
    window.addEventListener("unhandledrejection", onRejection);

    return {
        detach: () => {
            window.removeEventListener("error", onError, { capture: true });
            window.removeEventListener("unhandledrejection", onRejection);
        },
    };
};
