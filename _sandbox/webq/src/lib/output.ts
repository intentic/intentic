/* Where markdown lands and how it is named. A page's filename is its URL made readable plus a short hash:
 * readable so an agent scanning `ls` output can tell pages apart, hashed so two URLs that slug identically
 * (querystrings, trailing slashes) never overwrite each other, and slug-sanitized so no URL can spell a
 * path that escapes the output directory. Each file opens with front matter — the URL, title and fetch
 * time ride WITH the content, so a file found later (or by another agent) still says what it is. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tokensOf } from "./env.js";
import type { PageResult } from "./page.js";

export interface SavedPage {
    readonly path: string;
    readonly tokens: number;
}

export const slugFor = (url: string): string => {
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
    let readable: string;
    try {
        const parsed = new URL(url);
        readable = `${parsed.host}${parsed.pathname}`;
    } catch {
        readable = url;
    }
    const slug = readable
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, 80);
    return `${slug === "" ? "page" : slug}-${hash}.md`;
};

export const savePage = async (outDir: string, page: PageResult, fetchedAt: Date): Promise<SavedPage> => {
    await mkdir(outDir, { recursive: true });
    const path = join(outDir, slugFor(page.url));
    const frontMatter = [
        "---",
        `url: ${page.url}`,
        ...(page.finalUrl === page.url ? [] : [`final_url: ${page.finalUrl}`]),
        `title: ${JSON.stringify(page.meta.title)}`,
        `fetched_at: ${fetchedAt.toISOString()}`,
        `source: ${page.source}`,
        ...page.notes.map((note) => `note: ${JSON.stringify(note)}`),
        "---",
        "",
    ].join("\n");
    const content = `${frontMatter}${page.markdown}`;
    await writeFile(path, content);
    return { path, tokens: tokensOf(page.markdown) };
};

export interface IndexEntry {
    readonly url: string;
    readonly title: string;
    readonly path: string;
    readonly tokens: number;
    readonly depth: number;
}

export interface CrawlIndex {
    readonly markdownPath: string;
    readonly jsonPath: string;
}

/** The crawl's table of contents, as markdown for a reader and JSON for a program. */
export const saveIndex = async (outDir: string, startUrl: string, entries: IndexEntry[], skipped: Record<string, number>): Promise<CrawlIndex> => {
    await mkdir(outDir, { recursive: true });
    const sorted = entries.toSorted((a, b) => a.url.localeCompare(b.url));
    const markdownPath = join(outDir, "index.md");
    const jsonPath = join(outDir, "index.json");
    const skippedLine = Object.entries(skipped)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason} ${count}`)
        .join(", ");
    const lines = [
        `# Crawl of ${startUrl}`,
        "",
        `${entries.length} pages, ${entries.reduce((sum, entry) => sum + entry.tokens, 0)} tokens total.`,
        ...(skippedLine === "" ? [] : [`Skipped: ${skippedLine}.`]),
        "",
        "| title | url | file | tokens |",
        "| --- | --- | --- | --- |",
        ...sorted.map((entry) => `| ${entry.title.replaceAll("|", "\\|")} | ${entry.url} | ${entry.path} | ${entry.tokens} |`),
        "",
    ];
    await writeFile(markdownPath, lines.join("\n"));
    await writeFile(jsonPath, JSON.stringify({ startUrl, pages: sorted, skipped }, null, 2));
    return { markdownPath, jsonPath };
};
