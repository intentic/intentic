// @ts-check
// Per-page OpenGraph image generation. Runs on `astro:build:done`, reads each
// emitted page's <title>/<description>, and renders a 1200x628 PNG with satori + resvg.
//
// Paths resolve relative to `process.cwd()` (the Astro app being built), so this
// integration works unchanged when imported from a workspace package: drop
// `Inter-Regular.ttf` and `Inter-Bold.ttf` into `<app>/scripts/fonts/` to enable it.

import crypto from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_VERSION = "v3";
const projectRoot = process.cwd();
const fontsDir = path.join(projectRoot, "scripts/fonts");
const interRegularPath = path.join(fontsDir, "Inter-Regular.ttf");
const interBoldPath = path.join(fontsDir, "Inter-Bold.ttf");
const cacheDir = path.join(projectRoot, "node_modules/.cache/og");

const BG = "#181614";
const FG = "#faf9f7";
const MUTED = "#a5a099";
const ACCENT = "#e77a22";

function urlToSlug(pathname) {
    const trimmed = pathname.replace(/\/+$/, "");
    if (trimmed === "") return "index";
    return trimmed.replace(/^\//, "").replace(/\//g, "-");
}

function eyebrowFor(pathname) {
    const p = pathname.replace(/\/+$/, "") || "/";
    if (p === "/") return "intentic";
    if (p.startsWith("/docs")) return "Documentation";
    if (p.startsWith("/product")) return "The product";
    if (p === "/faq") return "FAQ";
    return "intentic";
}

function decodeHtmlEntities(s) {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&#8217;/g, "’")
        .replace(/&#8212;/g, "—");
}

function extractTitleAndDescription(html) {
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
    return {
        title: titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : null,
        description: descMatch ? decodeHtmlEntities(descMatch[1].trim()) : null,
    };
}

function ogTemplate({ title, description, eyebrow }) {
    return {
        type: "div",
        props: {
            style: {
                width: 1200,
                height: 628,
                display: "flex",
                flexDirection: "column",
                background: BG,
                padding: 80,
                color: FG,
                fontFamily: "Inter",
            },
            children: [
                {
                    type: "div",
                    props: {
                        style: { fontSize: 24, color: ACCENT, letterSpacing: 4, textTransform: "uppercase", fontWeight: 600 },
                        children: eyebrow,
                    },
                },
                {
                    type: "div",
                    props: {
                        style: { fontSize: 64, fontWeight: 700, marginTop: 32, lineHeight: 1.15, maxWidth: 1040 },
                        children: title,
                    },
                },
                {
                    type: "div",
                    props: {
                        style: { fontSize: 26, color: MUTED, marginTop: 32, lineHeight: 1.4, maxWidth: 1040 },
                        children: description,
                    },
                },
                {
                    type: "div",
                    props: {
                        style: { marginTop: "auto", fontSize: 24, color: ACCENT, fontWeight: 600 },
                        children: "intentic.dev",
                    },
                },
            ],
        },
    };
}

function cacheKey({ title, description, eyebrow }) {
    return crypto.createHash("sha256").update(`${TEMPLATE_VERSION}|${eyebrow}|${title}|${description}`).digest("hex");
}

/**
 * @returns {import('astro').AstroIntegration}
 */
export default function ogImages() {
    return {
        name: "intentic-og-images",
        hooks: {
            "astro:build:done": async ({ dir, pages, logger }) => {
                if (!existsSync(interRegularPath) || !existsSync(interBoldPath)) {
                    logger.warn(
                        `Inter TTF fonts not found at ${path.relative(projectRoot, fontsDir)}/. ` +
                            "Skipping per-page OG image generation. Drop Inter-Regular.ttf and Inter-Bold.ttf there to enable.",
                    );
                    return;
                }

                const [{ default: satori }, { Resvg }] = await Promise.all([import("satori"), import("@resvg/resvg-js")]);

                const fonts = [
                    { name: "Inter", data: readFileSync(interRegularPath), weight: 400, style: "normal" },
                    { name: "Inter", data: readFileSync(interBoldPath), weight: 700, style: "normal" },
                ];

                mkdirSync(cacheDir, { recursive: true });
                const distDir = fileURLToPath(dir);
                const outDir = path.join(distDir, "og");
                mkdirSync(outDir, { recursive: true });

                let generated = 0;
                let cached = 0;
                let skipped = 0;

                for (const page of pages) {
                    const pathname = `/${page.pathname.replace(/\/+$/, "")}`;
                    const normalized = pathname === "/" ? "/" : pathname;
                    const htmlPath = path.join(distDir, page.pathname || "", "index.html");
                    if (!existsSync(htmlPath)) {
                        skipped++;
                        continue;
                    }
                    const html = readFileSync(htmlPath, "utf-8");
                    const { title, description } = extractTitleAndDescription(html);
                    if (!title || !description) {
                        skipped++;
                        continue;
                    }

                    const eyebrow = eyebrowFor(normalized);
                    const key = cacheKey({ title, description, eyebrow });
                    const cachedPath = path.join(cacheDir, `${key}.png`);
                    const slug = urlToSlug(normalized);
                    const outPath = path.join(outDir, `${slug}.png`);

                    if (existsSync(cachedPath)) {
                        copyFileSync(cachedPath, outPath);
                        cached++;
                        continue;
                    }

                    const svg = await satori(ogTemplate({ title, description, eyebrow }), { width: 1200, height: 628, fonts });
                    const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
                    writeFileSync(outPath, png);
                    writeFileSync(cachedPath, png);
                    generated++;
                }

                logger.info(`OG images: ${generated} generated, ${cached} from cache, ${skipped} skipped.`);
            },
        },
    };
}
