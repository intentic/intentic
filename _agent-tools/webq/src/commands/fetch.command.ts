/* `webq fetch <url>`: one page as markdown — a capsule line saying what happened, the content up to a token budget. */
import { toolOutDir } from "@intentic/agent-cli/env";
import { type ErrorCode, failure, shellWord } from "@intentic/agent-cli/errors";
import { countParser } from "@intentic/agent-cli/flags";
import { capsule, clip } from "@intentic/agent-cli/output";
import { errorMessage, isFetchNetworkFailure, networkCodeOf } from "@intentic/base/errors";
import { buildCommand, type CommandContext } from "@stricli/core";
import { closeBrowser } from "../lib/browser.js";
import { DEFAULT_MAX_AGE_S } from "../lib/cache.js";
import { sharedFlagParameters, type SharedFlags, urlParser } from "../lib/flags.js";
import { savePage } from "../lib/output.js";
import { BrowserMissing, fetchPage, type PageResult } from "../lib/page.js";

type FetchFlags = SharedFlags & { readonly budget: number };

export const fetchCommand = buildCommand({
    docs: { brief: "One URL as clean markdown: budgeted on stdout, whole in a saved file" },
    parameters: {
        flags: {
            ...sharedFlagParameters,
            budget: { kind: "parsed", parse: countParser, default: "4000", brief: "Max stdout tokens; 0 prints only the capsule" },
        },
        positional: { kind: "tuple", parameters: [{ parse: urlParser, brief: "The page to fetch", placeholder: "url" }] },
    },
    async func(this: CommandContext, flags: FetchFlags, url: string) {
        try {
            let page: PageResult;
            try {
                page = await fetchPage(url, {
                    raw: flags.raw,
                    query: flags.query,
                    browser: flags.browser,
                    maxAgeS: flags.fresh ? 0 : (flags.maxAge ?? DEFAULT_MAX_AGE_S),
                    timeoutMs: flags.timeout * 1000,
                    threshold: flags.threshold,
                });
            } catch (cause) {
                const failed = fetchFailure(cause, url, flags.timeout);
                if (failed === undefined) {
                    throw cause;
                }
                this.process.stdout.write(failed);
                process.exitCode = 2;
                return;
            }
            const saved = await savePage(flags.out ?? toolOutDir("webq"), page, new Date());
            if (flags.json) {
                this.process.stdout.write(
                    `${JSON.stringify({ url, finalUrl: page.finalUrl, status: page.status, title: page.meta.title, tokens: saved.tokens, path: saved.path, source: page.source, notes: page.notes })}\n`,
                );
            } else {
                // An error page still has content (a bot check says what it wants), but it is not the page asked for.
                if (page.status >= 400) {
                    this.process.stdout.write(statusFailure(page, url));
                }
                this.process.stdout.write(capsule("webq", capsuleFields(page, saved.tokens, flags.raw), page.notes));
                this.process.stdout.write(`saved: ${saved.path}\n`);
                if (flags.budget > 0 && page.markdown !== "") {
                    this.process.stdout.write("---\n");
                    this.process.stdout.write(clip(page.markdown, flags.budget, { file: saved.path, firstLine: saved.firstLine }));
                }
            }
            process.exitCode = page.status >= 400 ? 1 : 0;
        } finally {
            await closeBrowser();
        }
    },
});

// A fetch that produced no page, as its failure line; undefined for a throw that is webq's own bug, left to the
// contract's `internal`.
const fetchFailure = (cause: unknown, url: string, timeoutS: number): string | undefined => {
    const message = errorMessage(cause).split("\n")[0] ?? "";
    // AbortSignal.timeout's DOMException and Playwright's navigation deadline both name themselves TimeoutError.
    if (cause instanceof Error && cause.name === "TimeoutError") {
        return failure("webq", "timeout", `${url} did not answer within ${timeoutS}s`, `webq fetch ${shellWord(url)} --timeout ${Math.max(60, timeoutS * 3)}`);
    }
    if (cause instanceof BrowserMissing) {
        return failure("webq", "missing_tool", message, `webq fetch ${shellWord(url)} --browser never`);
    }
    if (isFetchNetworkFailure(cause)) {
        const code = networkCodeOf(cause);
        const next =
            code === "ENOTFOUND" || code === "EAI_AGAIN"
                ? "check the host name in the URL: it does not resolve"
                : code === "ECONNREFUSED"
                  ? "check the URL's host and port: nothing is listening there"
                  : `webq fetch ${shellWord(url)} --browser force`;
        return failure("webq", "fetch_failed", `${url}: ${code ?? message}`, next);
    }
    // Chromium's own network errors, from a rendered fetch.
    if (/net::ERR_/.test(message)) {
        return failure("webq", "fetch_failed", `${url}: ${message}`);
    }
    return undefined;
};

// An HTTP error status as its code and what to try instead. Every answer is cached, an error page included, so asking
// again means --fresh.
const statusStep = (status: number, url: string): readonly [ErrorCode, string] => {
    const again = `webq fetch ${shellWord(url)} --fresh`;
    if (status === 404 || status === 410) {
        return ["not_found", "check the URL; what follows is the site's error page, not the page asked for"];
    }
    if (status === 401 || status === 407) {
        return ["blocked", "the page needs a sign-in, which webq does not do: open it in a signed-in browser"];
    }
    if (status === 403 || status === 451) {
        return ["blocked", `webq fetch ${shellWord(url)} --browser force --fresh`];
    }
    if (status === 429) {
        return ["blocked", `wait a minute, then ${again}`];
    }
    return ["fetch_failed", `${again} in a minute`];
};

const statusFailure = (page: PageResult, url: string): string => {
    const [code, next] = statusStep(page.status, url);
    return failure("webq", code, `HTTP ${page.status} from ${page.finalUrl}`, next);
};

// What a fetch has to say before its content: the page's name, where it really came from (redirects included),
// what it will cost to read, how much chrome was pruned, and whether the bytes were cached, fetched or rendered.
const capsuleFields = (page: PageResult, tokens: number, raw: boolean): string[] => [
    page.meta.title === "" ? page.finalUrl : page.meta.title,
    page.finalUrl,
    `${tokens} tokens`,
    raw ? "raw" : page.prunedShare === undefined ? "fit" : `fit (pruned ${Math.round(page.prunedShare * 100)}% of text mass)`,
    page.source,
];
