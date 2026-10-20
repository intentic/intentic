// @ts-check
// Markdown mirrors for machine readers, generated from the just-built pages, all derived so none can drift:
// - /llms.txt: the llmstxt.org index. With `compact`, a short one (what the product is, when it fits, where to start)
//   that links the full index, since an agent reads it whole and a 35 KB index of API routes buries the answer
// - /llms-index.txt: every page as a titled link, written only alongside a compact llms.txt
// - /llms-full.txt: the same pages inlined, so one fetch is the whole site
// - /<page>.md: a Markdown mirror of each page, linked from its HTML as rel="alternate"
// noindex pages are excluded: what isn't for a search engine isn't for a model either.

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
 * An llms.txt-shaped index: the name, the summary, optional details, then each section's built pages as titled links.
 * @param {{ name: string, summary: string }} head
 * @param {string | undefined} details
 * @param {{ label: string, paths: string[] }[]} listed
 * @param {Map<string, { mdUrl: string, title: string, description: string }>} built
 */
function indexLines(head, details, listed, built) {
    const lines = [`# ${head.name}`, "", `> ${head.summary}`];
    if (details) {
        lines.push("", details);
    }
    for (const section of listed) {
        const entries = section.paths.map((pathname) => built.get(pathname)).filter(Boolean);
        if (entries.length === 0) {
            continue;
        }
        lines.push("", `## ${section.label}`, "");
        for (const entry of entries) {
            lines.push(`- [${entry.title}](${entry.mdUrl}): ${entry.description}`);
        }
    }
    return lines;
}

/**
 * Writes /llms.txt, and with `compact` also /llms-index.txt: the compact index then links the full one.
 * @param {string} distDir
 * @param {string} origin
 * @param {{ name: string, summary: string, details?: string, compact?: { details?: string, sections: { label: string, paths: string[] }[] } }} options
 * @param {Map<string, { mdUrl: string, title: string, description: string }>} built
 * @param {{ label: string, paths: string[] }[]} sections every section of the full index, "More" included
 */
function writeIndexes(distDir, origin, options, built, sections) {
    const index = indexLines(options, options.details, sections, built);
    if (!options.compact) {
        writeFileSync(path.join(distDir, "llms.txt"), `${index.join("\n")}\n`);
        return;
    }
    const short = indexLines(options, options.compact.details ?? options.details, options.compact.sections, built);
    short.push(
        "",
        "## Optional",
        "",
        `- [Every page](${origin}/llms-index.txt): the full index, including docs, comparisons and the API reference`,
        `- [Every page, inlined](${origin}/llms-full.txt): the whole site in one Markdown file`,
    );
    writeFileSync(path.join(distDir, "llms.txt"), `${short.join("\n")}\n`);
    writeFileSync(path.join(distDir, "llms-index.txt"), `${index.join("\n")}\n`);
}

/**
 * @typedef {{ label: string, paths: string[] }} LlmsSection
 * @param {{ name: string, summary: string, details?: string, sections?: LlmsSection[], compact?: { details?: string, sections: LlmsSection[] } }} options
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
                        html = readFileSync(htmlPath, "utf8");
                    } catch (error) {
                        // The 404 page is built as dist/404.html, not under its pathname; any other miss is a mirror lost.
                        if (!/^404\/?$/.test(page.pathname)) {
                            logger.warn(`${htmlPath} could not be read (${error.message}); ${pathname} has no Markdown mirror.`);
                        }
                        continue;
                    }

                    const meta = readMeta(html);
                    if (meta.noindex || !meta.title) {
                        continue;
                    }

                    const body = htmlToMarkdown(extractContent(html), { origin });
                    if (!body) {
                        logger.warn(`No extractable content for ${pathname}; skipping its Markdown mirror.`);
                        continue;
                    }

                    const title = decodeAttr(meta.title);
                    const description = decodeAttr(meta.description ?? "");
                    const url = `${origin}${pathname}`;
                    const mdPath = markdownPathFor(pathname);
                    const markdown = `${frontMatter({ title, description, url, updated: meta.modified?.slice(0, 10) })}\n${body}\n`;

                    const outPath = path.join(distDir, mdPath);
                    mkdirSync(path.dirname(outPath), { recursive: true });
                    writeFileSync(outPath, markdown);

                    // Points the HTML at its own mirror here: the only place that knows the file was written.
                    const link = `<link rel="alternate" type="text/markdown" href="${mdPath}" title="Markdown">`;
                    writeFileSync(htmlPath, html.replace("</head>", `${link}</head>`));

                    built.set(pathname, { url, mdUrl: `${origin}${mdPath}`, title, description, markdown: body });
                }

                const sections = options.sections ?? [{ label: "Pages", paths: [...built.keys()] }];
                const listed = new Set(sections.flatMap((section) => section.paths));
                const unlisted = [...built.keys()].filter((pathname) => pathname !== "/" && !listed.has(pathname));

                writeIndexes(distDir, origin, options, built, [...sections, ...(unlisted.length ? [{ label: "More", paths: unlisted }] : [])]);

                // Landing page first, then sections in reading order, the order a human would read them.
                const order = [...new Set(["/", ...sections.flatMap((section) => section.paths), ...unlisted])];
                const full = [`# ${options.name}`, "", `> ${options.summary}`, ""];
                for (const pathname of order) {
                    const entry = built.get(pathname);
                    if (!entry) {
                        continue;
                    }
                    // No title line: every page's Markdown already opens with its own h1.
                    full.push("", "---", "", `Source: ${entry.url}`, "", entry.markdown);
                }
                writeFileSync(path.join(distDir, "llms-full.txt"), `${full.join("\n")}\n`);

                logger.info(`llms.txt written with ${built.size} pages, plus their Markdown mirrors.`);
            },
        },
    };
}
