import { Script, createContext } from "node:vm";
import type { UrlWatchSource } from "@intentic/sandbox-contract/schemas/automations";
import { errorMessage } from "@intentic/base/errors";
import { readCappedText } from "@intentic/base/capped-read";

// The daemon's own ready-made check (`url`): a page's text, or what a pattern matches on it, fetched with no shell, no
// extension and no model. It answers whether its condition holds and what it saw, which is what `fireOn: change`
// compares and what the wake is told. (2026-11-26) The npm and GitHub release checks left for the connectors extension's
// backend, which serves them as watch kinds it declares (watch-kinds.ts, contributed-check.ts); a page stays here, since
// it names no provider and every sandbox can use it.

export type SourceCheck =
    | { readonly pass: true; readonly output: string }
    // `detail` is what the check is still waiting for, in a sentence the run history shows.
    | { readonly pass: false; readonly detail: string };

export type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SourceContext {
    readonly fetch: SourceFetch;
}

// One request may take this long before the check reads as not passing; a 60-second guard has the same bound.
const FETCH_TIMEOUT_MS = 20_000;
// Count bytes as they arrive and cancel the rest: slicing a fully downloaded page never bounded the download.
const PAGE_MAX_BYTES = 2_000_000;
const USER_AGENT = "intentic-sandbox-watch";

// What upsert refuses, so a page that could never be checked is never saved: an address that is not http(s), a pattern
// that does not compile. Undefined when it can run.
export const sourceProblem = (source: UrlWatchSource): string | undefined => {
    if (!/^https?:\/\//.test(source.url)) {
        return "a watched page must be an http or https address";
    }
    if (source.select !== undefined) {
        try {
            // Compiled only to learn whether it can be; the check compiles its own each time.
            void new RegExp(source.select);
        } catch (error) {
            return `the select pattern does not compile: ${errorMessage(error)}`;
        }
    }
    return undefined;
};

const timed = async (context: SourceContext, url: string, headers: Record<string, string>): Promise<Response | string> => {
    try {
        const response = await context.fetch(url, {
            headers: { "user-agent": USER_AGENT, ...headers },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            // These checks report refusals by status alone. Release the unread body rather than holding its connection.
            // allow(silent-catch): cancellation cannot change the HTTP refusal the check already received.
            await response.body?.cancel().catch(() => undefined);
        }
        return response;
    } catch (error) {
        return `could not reach ${new URL(url).host}: ${errorMessage(error)}`;
    }
};

// A page's words, not its markup: scripts and styles go whole, tags go, entities a page always uses come back, and runs
// of whitespace become one, so a page re-rendered with fresh nonces does not read as changed.
export const pageText = (html: string): string =>
    html
        .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();

// How long one `select` pattern may run against a page. A pattern that backtracks (`(a+)+$`) on a page that feeds it
// takes exponential time, and on the daemon's own thread that is every conversation frozen, so it is stopped instead.
const SELECT_TIMEOUT_MS = 1_000;
const selectRun = new Script("match = pattern.exec(text)");

// The pattern's first match on the page, or "timeout" when it would not finish in time. Run inside a context of its own
// only for the deadline, which V8 enforces even mid-backtrack; the pattern and page are plain values, nothing escapes.
const boundedMatch = (pattern: string, text: string): RegExpExecArray | null | "timeout" => {
    const scope: { pattern: RegExp; text: string; match: RegExpExecArray | null } = { pattern: new RegExp(pattern), text, match: null };
    const context = createContext(scope);
    try {
        selectRun.runInContext(context, { timeout: SELECT_TIMEOUT_MS });
    } catch (error) {
        if ((error as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
            return "timeout";
        }
        throw error;
    }
    return scope.match;
};

const checkUrl = async (source: UrlWatchSource, context: SourceContext): Promise<SourceCheck> => {
    const response = await timed(context, source.url, { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" });
    if (typeof response === "string") {
        return { pass: false, detail: response };
    }
    if (!response.ok) {
        return { pass: false, detail: `the page answered ${response.status}` };
    }
    const { text: body } = await readCappedText(response, PAGE_MAX_BYTES);
    if (source.select === undefined) {
        const html = (response.headers.get("content-type") ?? "").includes("html");
        return { pass: true, output: html ? pageText(body) : body.trim() };
    }
    // Matched against the page as served, so a pattern can anchor on markup; its first group when it has one.
    const match = boundedMatch(source.select, body);
    if (match === "timeout") {
        return {
            pass: false,
            detail: `matching ${source.select} against the page took longer than ${SELECT_TIMEOUT_MS / 1_000}s, so it was stopped: simplify the pattern`,
        };
    }
    if (match === null) {
        return { pass: false, detail: `nothing on the page matches ${source.select}` };
    }
    return { pass: true, output: (match[1] ?? match[0]).trim() };
};

export const checkUrlSource = async (source: UrlWatchSource, context: SourceContext): Promise<SourceCheck> => {
    try {
        return await checkUrl(source, context);
    } catch (error) {
        // A body that would not be read is a check that did not pass, said as such, never a crashed tick.
        return { pass: false, detail: `the check failed: ${errorMessage(error)}` };
    }
};
