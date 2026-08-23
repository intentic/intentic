/* `webq fetch <url>`: one page as markdown — a capsule line saying what happened, the content up to a
 * token budget, and always a saved file carrying the whole thing. The budget exists because the reader is
 * an agent's context window: a 300k-token page printed whole is an attack on the caller, so the tail lives
 * in the file and the cut is announced with the exact path to Read. */
import { buildCommand, type CommandContext } from "@stricli/core";
import { closeBrowser } from "../lib/browser.js";
import { DEFAULT_MAX_AGE_S } from "../lib/cache.js";
import { defaultOutDir, tokensOf } from "../lib/env.js";
import { numberParser, sharedFlagParameters, type SharedFlags, urlParser } from "../lib/flags.js";
import { savePage } from "../lib/output.js";
import { fetchPage } from "../lib/page.js";

type FetchFlags = SharedFlags & { readonly budget: number };

export const fetchCommand = buildCommand({
    docs: { brief: "One URL as clean markdown: budgeted on stdout, whole in a saved file" },
    parameters: {
        flags: {
            ...sharedFlagParameters,
            budget: { kind: "parsed", parse: numberParser, default: "4000", brief: "Max stdout tokens; 0 prints only the capsule" },
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
            const saved = await savePage(flags.out ?? defaultOutDir(), page, new Date());
            if (flags.json) {
                this.process.stdout.write(
                    `${JSON.stringify({ url, finalUrl: page.finalUrl, status: page.status, title: page.meta.title, tokens: saved.tokens, path: saved.path, source: page.source, notes: page.notes })}\n`,
                );
            } else {
                this.process.stdout.write(capsule(page.meta.title, page.finalUrl, saved.tokens, page.source, flags, page.prunedShare, page.notes));
                this.process.stdout.write(`saved: ${saved.path}\n`);
                if (flags.budget > 0 && page.markdown !== "") {
                    this.process.stdout.write("---\n");
                    this.process.stdout.write(clip(page.markdown, flags.budget, saved.path));
                }
            }
            process.exitCode = page.status >= 400 ? 1 : 0;
        } finally {
            await closeBrowser();
        }
    },
});

const capsule = (
    title: string,
    finalUrl: string,
    tokens: number,
    source: string,
    flags: FetchFlags,
    prunedShare: number | undefined,
    notes: string[],
): string => {
    const mode = flags.raw ? "raw" : prunedShare === undefined ? "fit" : `fit (pruned ${Math.round(prunedShare * 100)}% of text mass)`;
    const head = `webq: ${title === "" ? finalUrl : title} · ${finalUrl} · ${tokens} tokens · ${mode} · ${source}\n`;
    return head + notes.map((note) => `note: ${note}\n`).join("");
};

const clip = (markdown: string, budgetTokens: number, path: string): string => {
    if (tokensOf(markdown) <= budgetTokens) {
        return markdown;
    }
    const cut = markdown.slice(0, budgetTokens * 4);
    const atLine = cut.slice(0, cut.lastIndexOf("\n") + 1);
    return `${atLine}\n[cut at ${budgetTokens} of ${tokensOf(markdown)} tokens: Read ${path} for the whole page]\n`;
};
