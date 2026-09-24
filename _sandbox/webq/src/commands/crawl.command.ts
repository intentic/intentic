/* `webq crawl <url>`: a bounded same-site crawl into a directory of markdown files plus an index. */
import { join } from "node:path";
import { toolOutDir } from "@intentic/agent-cli/env";
import { countParser } from "@intentic/agent-cli/flags";
import { buildCommand, type CommandContext } from "@stricli/core";
import { DEFAULT_MAX_AGE_S } from "../lib/cache.js";
import { crawl } from "../lib/crawl.js";
import { sharedFlagParameters, type SharedFlags, urlParser } from "../lib/flags.js";
import { slugFor } from "../lib/output.js";

// Failed pages named one per line before the rest are counted; the JSON report carries all of them.
const FAILURES_SHOWN = 10;

type CrawlFlags = SharedFlags & {
    readonly maxPages: number;
    readonly depth: number;
    readonly concurrency: number;
    readonly sitemap: boolean;
    readonly external: boolean;
    readonly ignoreRobots: boolean;
    readonly include?: string[];
    readonly exclude?: string[];
    readonly delay: number;
};

export const crawlCommand = buildCommand({
    docs: { brief: "Bounded same-site crawl: one markdown file per page, plus an index" },
    parameters: {
        flags: {
            ...sharedFlagParameters,
            maxPages: { kind: "parsed", parse: countParser, default: "20", brief: "Hard page cap" },
            depth: { kind: "parsed", parse: countParser, default: "2", brief: "Link hops from the start URL" },
            concurrency: { kind: "parsed", parse: countParser, default: "4", brief: "Pages in flight at once" },
            sitemap: { kind: "boolean", default: false, brief: "Seed the frontier from the site's sitemap" },
            external: { kind: "boolean", default: false, brief: "Follow links off the start origin too" },
            ignoreRobots: { kind: "boolean", default: false, brief: "Crawl paths robots.txt disallows (your responsibility)" },
            include: { kind: "parsed", parse: String, variadic: true, optional: true, brief: "Only URLs containing this (or *-glob); repeatable" },
            exclude: { kind: "parsed", parse: String, variadic: true, optional: true, brief: "Skip URLs containing this (or *-glob); repeatable" },
            delay: { kind: "parsed", parse: countParser, default: "0", brief: "Milliseconds between requests (robots crawl-delay still respected)" },
        },
        positional: { kind: "tuple", parameters: [{ parse: urlParser, brief: "Where the crawl starts", placeholder: "url" }] },
    },
    async func(this: CommandContext, flags: CrawlFlags, url: string) {
        const outDir = flags.out ?? join(toolOutDir("webq"), slugFor(url).replace(/\.md$/, ""));
        const report = await crawl(url, {
            outDir,
            maxPages: flags.maxPages,
            maxDepth: flags.depth,
            concurrency: flags.concurrency,
            robots: !flags.ignoreRobots,
            sitemap: flags.sitemap,
            external: flags.external,
            ...(flags.include === undefined ? {} : { include: flags.include }),
            ...(flags.exclude === undefined ? {} : { exclude: flags.exclude }),
            delayMs: flags.delay,
            raw: flags.raw,
            query: flags.query,
            browser: flags.browser,
            maxAgeS: flags.fresh ? 0 : (flags.maxAge ?? DEFAULT_MAX_AGE_S),
            timeoutMs: flags.timeout * 1000,
            threshold: flags.threshold,
        });
        if (flags.json) {
            this.process.stdout.write(`${JSON.stringify(report)}\n`);
            process.exitCode = report.pages.length > 0 ? 0 : 1;
            return;
        }
        const totalTokens = report.pages.reduce((sum, page) => sum + page.tokens, 0);
        const skipLine = Object.entries(report.skipped)
            .filter(([, count]) => count > 0)
            .map(([reason, count]) => `${reason} ${count}`)
            .join(", ");
        this.process.stdout.write(
            `webq crawl: ${url} · ${report.pages.length} pages · ${totalTokens} tokens${skipLine === "" ? "" : ` · skipped: ${skipLine}`}\n`,
        );
        for (const { url: failed, reason } of report.failures.slice(0, FAILURES_SHOWN)) {
            this.process.stdout.write(`failed: ${failed}: ${reason}\n`);
        }
        if (report.failures.length > FAILURES_SHOWN) {
            this.process.stdout.write(`…and ${report.failures.length - FAILURES_SHOWN} more failed pages (--json lists every one)\n`);
        }
        if (report.sitemapCapped) {
            this.process.stdout.write("note: sitemap larger than the seed cap, frontier seeded from a prefix of it\n");
        }
        this.process.stdout.write(`index: ${report.indexMarkdown}\n`);
        for (const page of report.pages) {
            this.process.stdout.write(`  ${page.tokens}t d${page.depth} ${page.url} → ${page.path}\n`);
            for (const note of page.notes) {
                this.process.stdout.write(`    note: ${note}\n`);
            }
        }
        process.exitCode = report.pages.length > 0 ? 0 : 1;
    },
});
