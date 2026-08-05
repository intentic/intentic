// @ts-check
// Markdown mirrors for machine readers, generated from the pages that were just built.
//
// Three artefacts, all derived — none hand-maintained, so none can drift from the site:
//   /llms.txt        the llmstxt.org index: what this site is, and every page as a titled link
//   /llms-full.txt   the same pages inlined, so one fetch is the whole site
//   /<page>.md       a Markdown mirror of each page, linked from its HTML as rel="alternate"
//
// An LLM that fetches a page gets prose instead of 80 KB of Tailwind-classed markup, and a crawler
// that only reads llms.txt still learns the whole structure. noindex pages are excluded: what is not
// for a search engine is not for a model either.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractContent, htmlToMarkdown } from "./html-to-markdown.mjs";

/** `/docs/quickstart/` → `/docs/quickstart.md`; the site root → `/index.md`. */
export function markdownPathFor(pathname) {
    const trimmed = pathname.replace(/\/+$/, "");
    return trimmed === "" ? "/index.md" : `${trimmed}.md`;
}

function readMeta(html) {
    const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    const description = html.match(/<meta name="description" content="([^"]*)"/i)?.[1];
    const modified = html.match(/<meta property="article:modified_time" content="([^"]*)"/i)?.[1];
    const noindex = /<meta name="robots" content="[^"]*noindex/i.test(html);
    return { title, description, modified, noindex };
}

function decodeAttr(value) {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

function frontMatter(fields) {
    const lines = Object.entries(fields)
        .filter(([, value]) => value)
        // Quote every value: titles carry colons and em dashes, which bare YAML scalars mangle.
        .map(([key, value]) => `${key}: "${String(value).replace(/"/g, '\\"')}"`);
    return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * @typedef {{ label: string, paths: string[] }} LlmsSection
 * @param {{ name: string, summary: string, details?: string, sections?: LlmsSection[] }} options
 * @returns {import('astro').AstroIntegration}
 */
export default function llmsText(options) {
    let origin = "";

    return {
        name: "intentic-llms-text",
        hooks: {
            "astro:config:done": ({ config }) => {
                origin = config.site ? config.site.replace(/\/+$/, "") : "";
            },
            "astro:build:done": ({ dir, pages, logger }) => {
                const distDir = fileURLToPath(dir);
                /** @type {Map<string, { url: string, mdUrl: string, title: string, description: string, markdown: string }>} */
                const built = new Map();

                for (const page of pages) {
                    const pathname = `/${page.pathname}`;
                    const htmlPath = path.join(distDir, page.pathname, "index.html");
                    let html;
                    try {
                        html = readFileSync(htmlPath, "utf-8");
                    } catch {
                        continue;
                    }

                    const meta = readMeta(html);
                    if (meta.noindex || !meta.title) continue;

                    const body = htmlToMarkdown(extractContent(html), { origin });
                    if (!body) {
                        logger.warn(`No extractable content for ${pathname}; skipping its Markdown mirror.`);
                        continue;
                    }

                    const title = decodeAttr(meta.title);
                    const description = decodeAttr(meta.description ?? "");
                    const url = `${origin}${pathname}`;
                    const mdPath = markdownPathFor(pathname);
                    const markdown = frontMatter({ title, description, url, updated: meta.modified?.slice(0, 10) }) + `\n${body}\n`;

                    const outPath = path.join(distDir, mdPath);
                    mkdirSync(path.dirname(outPath), { recursive: true });
                    writeFileSync(outPath, markdown);

                    // Point the HTML at its own mirror, here rather than in the layout: this is the only
                    // place that knows the file was actually written, so the link cannot 404.
                    const link = `<link rel="alternate" type="text/markdown" href="${mdPath}" title="Markdown">`;
                    writeFileSync(htmlPath, html.replace("</head>", `${link}</head>`));

                    built.set(pathname, { url, mdUrl: `${origin}${mdPath}`, title, description, markdown: body });
                }

                const sections = options.sections ?? [{ label: "Pages", paths: [...built.keys()] }];
                const listed = new Set(sections.flatMap((section) => section.paths));
                const unlisted = [...built.keys()].filter((pathname) => pathname !== "/" && !listed.has(pathname));

                const index = [`# ${options.name}`, "", `> ${options.summary}`];
                if (options.details) index.push("", options.details);
                for (const section of [...sections, ...(unlisted.length ? [{ label: "More", paths: unlisted }] : [])]) {
                    const entries = section.paths.map((pathname) => built.get(pathname)).filter(Boolean);
                    if (entries.length === 0) continue;
                    index.push("", `## ${section.label}`, "");
                    for (const entry of entries) index.push(`- [${entry.title}](${entry.mdUrl}): ${entry.description}`);
                }
                writeFileSync(path.join(distDir, "llms.txt"), `${index.join("\n")}\n`);

                // Landing page first, then the sections in reading order — the order a human would read them.
                const order = [...new Set(["/", ...sections.flatMap((section) => section.paths), ...unlisted])];
                const full = [`# ${options.name}`, "", `> ${options.summary}`, ""];
                for (const pathname of order) {
                    const entry = built.get(pathname);
                    if (!entry) continue;
                    // No title line: every page's Markdown already opens with its own h1.
                    full.push("", "---", "", `Source: ${entry.url}`, "", entry.markdown);
                }
                writeFileSync(path.join(distDir, "llms-full.txt"), `${full.join("\n")}\n`);

                logger.info(`llms.txt written with ${built.size} pages, plus their Markdown mirrors.`);
            },
        },
    };
}
