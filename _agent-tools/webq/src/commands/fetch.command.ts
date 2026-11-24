/* `webq fetch <url>`: one page as markdown — a capsule line saying what happened, the content up to a token budget. */
import { toolOutDir } from "@intentic/agent-cli/env";
import { countParser } from "@intentic/agent-cli/flags";
import { capsule, clip } from "@intentic/agent-cli/output";
import { buildCommand, type CommandContext } from "@stricli/core";
import { closeBrowser } from "../lib/browser.js";
import { DEFAULT_MAX_AGE_S } from "../lib/cache.js";
import { sharedFlagParameters, type SharedFlags, urlParser } from "../lib/flags.js";
import { savePage } from "../lib/output.js";
import { fetchPage, type PageResult } from "../lib/page.js";

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
            const page = await fetchPage(url, {
                raw: flags.raw,
                query: flags.query,
                browser: flags.browser,
                maxAgeS: flags.fresh ? 0 : (flags.maxAge ?? DEFAULT_MAX_AGE_S),
                timeoutMs: flags.timeout * 1000,
                threshold: flags.threshold,
            });
            const saved = await savePage(flags.out ?? toolOutDir("webq"), page, new Date());
            if (flags.json) {
                this.process.stdout.write(
                    `${JSON.stringify({ url, finalUrl: page.finalUrl, status: page.status, title: page.meta.title, tokens: saved.tokens, path: saved.path, source: page.source, notes: page.notes })}\n`,
                );
            } else {
                this.process.stdout.write(capsule("webq", capsuleFields(page, saved.tokens, flags.raw), page.notes));
                this.process.stdout.write(`saved: ${saved.path}\n`);
                if (flags.budget > 0 && page.markdown !== "") {
                    this.process.stdout.write("---\n");
                    this.process.stdout.write(clip(page.markdown, flags.budget, saved.path, "page"));
                }
            }
            process.exitCode = page.status >= 400 ? 1 : 0;
        } finally {
            await closeBrowser();
        }
    },
});

// What a fetch has to say before its content: the page's name, where it really came from (redirects included),
// what it will cost to read, how much chrome was pruned, and whether the bytes were cached, fetched or rendered.
const capsuleFields = (page: PageResult, tokens: number, raw: boolean): string[] => [
    page.meta.title === "" ? page.finalUrl : page.meta.title,
    page.finalUrl,
    `${tokens} tokens`,
    raw ? "raw" : page.prunedShare === undefined ? "fit" : `fit (pruned ${Math.round(page.prunedShare * 100)}% of text mass)`,
    page.source,
];
