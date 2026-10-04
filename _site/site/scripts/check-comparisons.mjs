// Focused content/research checks, plus generated HTML checks after `astro build`.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "@intentic/constants/node";
import { chromium } from "playwright";
import { compareFamilies, compareHref, compareIndex, comparePages } from "@intentic/site-content/compare";
import { SITE_URL } from "@intentic/site-content/site";

const contentOnly = process.argv.includes("--content-only");
const research = await readFile(join(repoRoot(import.meta.url), "docs/marketing/comparison-search-research.md"), "utf8");
const entries = [
    { path: compareHref(""), copy: compareIndex },
    ...comparePages.map((copy) => ({ path: compareHref(copy.slug), copy })),
];
const paths = new Set(entries.map((entry) => entry.path));
const familyIds = new Set(compareFamilies.map((family) => family.id));
const titles = new Set();
const descriptions = new Set();
const headings = new Set();

for (const { path, copy } of entries) {
    assert(copy.meta.title.trim(), `${path}: missing title`);
    assert(copy.meta.description.trim(), `${path}: missing description`);
    assert(!titles.has(copy.meta.title), `${path}: duplicate title`);
    assert(!descriptions.has(copy.meta.description), `${path}: duplicate description`);
    assert(!headings.has(copy.heading), `${path}: duplicate H1`);
    titles.add(copy.meta.title);
    descriptions.add(copy.meta.description);
    headings.add(copy.heading);
    assert(copy.faq.length > 0, `${path}: missing visible FAQs`);
    assert.equal(new Set(copy.faq.map((item) => item.question)).size, copy.faq.length, `${path}: repeated FAQ`);
    for (const item of copy.faq) {
        assert(item.question.trim() && item.answer.trim(), `${path}: empty FAQ`);
    }
    if ("slug" in copy) {
        assert(familyIds.has(copy.family), `${path}: unknown comparison family`);
        assert(copy.table.some((row) => row.theirs), `${path}: missing a genuine competitor strength`);
        assert(copy.sources.length > 0, `${path}: missing official sources`);
        for (const source of copy.sources) {
            assert.equal(new URL(source.url).protocol, "https:", `${path}: invalid source URL`);
        }
        assert.match(copy.verifiedOn, /^\d{4}-\d{2}-\d{2}$/u, `${path}: invalid source-review date`);
        assert(copy.verifiedOn >= copy.meta.datePublished, `${path}: review predates publication`);
    }

    const start = research.indexOf(`## ${path}\n`);
    assert(start >= 0, `${path}: missing keyword research`);
    const end = research.indexOf("\n## /compare/", start + 1);
    const section = research.slice(start, end < 0 ? undefined : end);
    const rows = section.split("\n").filter((line) => /^\| \d+ \|/u.test(line));
    assert.equal(rows.length, 10, `${path}: expected ten researched search targets`);
    const targets = rows.map((line) => line.split("|")[2].trim());
    assert.equal(new Set(targets).size, 10, `${path}: repeated search target`);
    const locations = new Set([
        "Introduction",
        copy.heading,
        ...copy.faq.map((item) => item.question),
        ...("slug" in copy
            ? [...copy.differences.map((item) => item.title), ...copy.table.map((row) => row.label), ...(copy.together ? [copy.together.title] : [])]
            : [...compareFamilies.map((family) => family.label), ...copy.axes.items.map((item) => item.title)]),
    ]);
    rows.forEach((row, index) => {
        const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
        assert.equal(Number(cells[0]), index + 1, `${path}: unordered search priorities`);
        assert.match(cells[2], /^(A|S|I)\b/u, `${path}: missing evidence classification`);
        assert(locations.has(cells[3]), `${path}: research points to a missing answer: ${cells[3]}`);
    });
}
assert.equal(paths.size, entries.length, "Duplicate comparison routes");
console.log(`Content and research: ${entries.length} pages, ${entries.length * 10} distinct per-page targets checked.`);

if (!contentOnly) {
    const browser = await chromium.launch({ headless: true, channel: "chromium" });
    try {
        // Inspect the built DOM without running analytics, visitor chat, or other page scripts.
        const context = await browser.newContext({ javaScriptEnabled: false });
        const page = await context.newPage();
        await page.route("**/*", (route) => route.abort());
        const sitemap = await readFile(new URL("../dist/sitemap-0.xml", import.meta.url), "utf8");
        for (const { path, copy } of entries) {
            const output = new URL(`../dist${path}index.html`, import.meta.url);
            let html;
            try {
                html = await readFile(output, "utf8");
            } catch (cause) {
                throw new Error(`Missing ${fileURLToPath(output)}. Run the site build before HTML checks.`, { cause });
            }
            await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15_000 });
            const rendered = await page.evaluate(() => ({
                title: document.title,
                description: document.querySelector('meta[name="description"]')?.getAttribute("content"),
                canonical: [...document.querySelectorAll('link[rel="canonical"]')].map((node) => node.getAttribute("href")),
                h1: [...document.querySelectorAll("main h1")].map((node) => node.textContent.trim()),
                faq: [...document.querySelectorAll("#faq h3")].map((node) => ({
                    question: node.textContent.trim(),
                    answer: node.nextElementSibling?.textContent.trim(),
                })),
                graph: JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)["@graph"],
                comparisonLinks: [...document.querySelectorAll('main a[href^="/compare/"]')].map((node) => node.getAttribute("href")),
                reviewedOn: document.querySelector("main time[datetime]")?.getAttribute("datetime"),
            }));
            const canonical = `${SITE_URL}${path}`;
            assert.equal(rendered.title, copy.meta.title, `${path}: incorrect title`);
            assert.equal(rendered.description, copy.meta.description, `${path}: incorrect description`);
            assert.deepEqual(rendered.canonical, [canonical], `${path}: incorrect canonical`);
            assert.deepEqual(rendered.h1, [copy.heading], `${path}: missing/duplicate H1`);
            assert.deepEqual(rendered.faq, copy.faq, `${path}: FAQs missing from visible HTML`);
            const faqNode = rendered.graph.find((node) => node["@type"] === "FAQPage");
            assert(faqNode, `${path}: missing FAQ structured data`);
            assert.deepEqual(
                faqNode.mainEntity.map((question) => ({ question: question.name, answer: question.acceptedAnswer.text })),
                rendered.faq,
                `${path}: FAQ structured data differs from visible answers`,
            );
            for (const href of rendered.comparisonLinks) {
                assert(paths.has(href), `${path}: broken comparison link ${href}`);
            }
            if ("slug" in copy) {
                assert.equal(rendered.reviewedOn, copy.verifiedOn, `${path}: incorrect source-review date`);
            } else {
                const unlinked = comparePages.filter((detail) => !rendered.comparisonLinks.includes(compareHref(detail.slug))).map((detail) => detail.name);
                assert.deepEqual(unlinked, [], `Hub is missing ${unlinked.join(", ")}`);
            }
            assert(sitemap.includes(`<loc>${canonical}</loc>`), `${path}: missing sitemap entry`);
        }
        await context.close();
        console.log(`Generated HTML: titles, descriptions, canonicals, H1s, visible/structured FAQs, source dates, links and sitemap checked for ${entries.length} pages.`);
    } finally {
        await browser.close();
    }
}
