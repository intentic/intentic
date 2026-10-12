import { sanitizeText, sanitizeUrl } from "../tools/network-redaction.js";

// What went wrong inside an owner's window while it was open, kept in memory and said once when it closes. A sign-in
// that fails shows the owner a page, and the log nothing: the one time it was chased (a Google sign-in refused inside
// X), learning which request the site turned down took rebuilding the whole launch by hand. Only what a sign-in is
// debugged by is kept: pages and API calls that failed, and the page's own console errors, every URL with its query
// values, fragment and userinfo masked and every console line through the credential mask (network-redaction.ts).

// Enough to see the shape of a failure (the request that failed and what retried after it) without the log line
// growing with how long the window stayed open; the totals still count everything.
const KEPT = 20;
// A console error can be a whole minified stack.
const TEXT_CAP = 300;
// Pages and API calls; a missing favicon or a blocked tracker pixel is noise beside them.
const WATCHED_TYPES: ReadonlySet<string> = new Set(["document", "xhr", "fetch"]);

export interface WindowFailure {
    readonly at: string;
    readonly kind: "response" | "requestfailed" | "console";
    readonly method?: string;
    readonly url?: string;
    readonly status?: number;
    readonly error?: string;
    readonly text?: string;
}

export interface WindowFailureSummary {
    readonly total: number;
    readonly responses: number;
    readonly requestsFailed: number;
    readonly consoleErrors: number;
    // The newest KEPT, oldest first.
    readonly recent: readonly WindowFailure[];
}

interface RequestLike {
    method(): string;
    url(): string;
    resourceType(): string;
    failure(): { errorText: string } | null;
}

interface ResponseLike {
    status(): number;
    url(): string;
    request(): Pick<RequestLike, "method" | "resourceType">;
}

interface ConsoleLike {
    type(): string;
    text(): string;
}

// The three BrowserContext events read, as far as this reads them.
export interface FailureSource {
    on(event: "response", listener: (response: ResponseLike) => void): unknown;
    on(event: "requestfailed", listener: (request: RequestLike) => void): unknown;
    on(event: "console", listener: (message: ConsoleLike) => void): unknown;
    off(event: "response", listener: (response: ResponseLike) => void): unknown;
    off(event: "requestfailed", listener: (request: RequestLike) => void): unknown;
    off(event: "console", listener: (message: ConsoleLike) => void): unknown;
}

const cap = (text: string): string => (text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text);

export const createFailureRing = (now: () => Date = () => new Date()) => {
    const recent: WindowFailure[] = [];
    const counts = { responses: 0, requestsFailed: 0, consoleErrors: 0 };
    const push = (failure: Omit<WindowFailure, "at">): void => {
        recent.push({ at: now().toISOString(), ...failure });
        if (recent.length > KEPT) {
            recent.shift();
        }
    };
    return {
        response: (response: ResponseLike): void => {
            const request = response.request();
            if (response.status() < 400 || !WATCHED_TYPES.has(request.resourceType())) {
                return;
            }
            counts.responses += 1;
            push({ kind: "response", method: request.method(), url: cap(sanitizeUrl(response.url())), status: response.status() });
        },
        requestFailed: (request: RequestLike): void => {
            if (!WATCHED_TYPES.has(request.resourceType())) {
                return;
            }
            counts.requestsFailed += 1;
            push({
                kind: "requestfailed",
                method: request.method(),
                url: cap(sanitizeUrl(request.url())),
                error: request.failure()?.errorText ?? "unknown",
            });
        },
        console: (message: ConsoleLike): void => {
            if (message.type() !== "error") {
                return;
            }
            counts.consoleErrors += 1;
            push({ kind: "console", text: cap(sanitizeText(message.text())) });
        },
        summary: (): WindowFailureSummary => ({
            total: counts.responses + counts.requestsFailed + counts.consoleErrors,
            ...counts,
            recent: [...recent],
        }),
    };
};

// Listens on the context until stop(); summary() can be read at any time, the close line reads it once.
export const watchWindowFailures = (context: FailureSource) => {
    const ring = createFailureRing();
    context.on("response", ring.response);
    context.on("requestfailed", ring.requestFailed);
    context.on("console", ring.console);
    return {
        summary: ring.summary,
        stop: (): void => {
            context.off("response", ring.response);
            context.off("requestfailed", ring.requestFailed);
            context.off("console", ring.console);
        },
    };
};
