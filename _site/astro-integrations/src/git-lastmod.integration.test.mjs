// @ts-check
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { requires } from "@intentic/testing/requires";

const node = Bun.which("node");
const needs = requires(node !== null && Bun.which("git") !== null, "git and Node.js on PATH");
const gitTest = test.skipIf(!needs.runs);
const moduleUrl = new URL("./git-lastmod.mjs", import.meta.url).href;
const initialDate = "2026-01-01T10:00:00+02:00";
const contentDate = "2026-02-01T12:00:00+02:00";
const templateDate = "2026-03-01T10:00:00+02:00";
const comparisonContent = "../site-content/src/compare.ts";
const detailTemplate = "src/pages/compare/[slug].astro";
const hubTemplate = "src/pages/compare/index.astro";
const sources = [
    "src/pages/index.astro",
    "src/pages/pricing.astro",
    "src/pages/docs/index.astro",
    "src/pages/both.astro",
    "src/pages/both/index.astro",
    detailTemplate,
    hubTemplate,
    comparisonContent,
];
/** @type {string} */
let root;
/** @type {string} */
let site;

/**
 * @param {string} source
 * @param {string} text
 */
function writeSource(source, text) {
    const file = join(site, source);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git-lastmod-"));
    site = join(root, "_site/site");
    for (const source of sources) {
        writeSource(source, `fixture for ${source}\n`);
    }
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/**
 * @param {string[]} args
 * @param {string} [date]
 */
function git(args, date) {
    execFileSync(
        "git",
        [
            "-c",
            "user.name=Lastmod Tests",
            "-c",
            "user.email=lastmod-tests",
            "-c",
            "commit.gpgSign=false",
            "-c",
            `core.hooksPath=${join(root, "no-hooks")}`,
            ...args,
        ],
        {
            cwd: root,
            stdio: "ignore",
            env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        },
    );
}

function initRepository() {
    git(["-c", "init.templateDir=", "init", "--quiet"]);
}

/**
 * @param {string} date
 * @param {string[]} [paths]
 */
function commit(date, paths = sources) {
    git(["add", "--", ...paths.map((source) => join("_site/site", source))]);
    git(["commit", "--quiet", "-m", "fixture"], date);
}

/**
 * Each Node process loads the build-time helper from the fixture site's cwd, with its own URL cache.
 * @param {string[]} paths
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {(string | null)[]}
 */
function datesFor(paths, env = {}) {
    if (node === null) {
        throw new Error("Node.js is required to load the build-time helper");
    }
    const code = `
        import { lastModForUrl } from ${JSON.stringify(moduleUrl)};
        const dates = ${JSON.stringify(paths)}.map((pathname) => lastModForUrl(new URL(pathname, "https://intentic.dev").href));
        process.stdout.write(JSON.stringify(dates));
    `;
    return JSON.parse(execFileSync(node, ["--input-type=module", "--eval", code], { cwd: site, encoding: "utf8", env: { ...process.env, ...env } }));
}

gitTest(needs.title("comparison details track content and shared-template commits"), () => {
    initRepository();
    commit(initialDate);
    writeSource(comparisonContent, "updated comparison content\n");
    commit(contentDate, [comparisonContent]);
    const paths = ["/compare/cursor/", "/compare/opencode", "/compare/"];
    expect(datesFor(paths)).toEqual([contentDate, contentDate, contentDate]);

    writeSource(detailTemplate, "updated detail template\n");
    commit(templateDate, [detailTemplate]);
    expect(datesFor(paths)).toEqual([templateDate, templateDate, contentDate]);
});

gitTest(needs.title("comparison hub tracks content and its own template, not the detail template"), () => {
    initRepository();
    commit(initialDate);
    writeSource(comparisonContent, "updated comparison content\n");
    commit(contentDate, [comparisonContent]);
    const paths = ["/compare/", "/compare", "/compare/cursor/"];
    expect(datesFor(paths)).toEqual([contentDate, contentDate, contentDate]);

    writeSource(hubTemplate, "updated hub template\n");
    commit(templateDate, [hubTemplate]);
    expect(datesFor(paths)).toEqual([templateDate, templateDate, contentDate]);
});

gitTest(needs.title("ordinary routes keep their own history and literal-file precedence"), () => {
    initRepository();
    commit(initialDate);
    writeSource(comparisonContent, "updated comparison content\n");
    writeSource("src/pages/both/index.astro", "updated lower-priority index\n");
    commit(contentDate, [comparisonContent, "src/pages/both/index.astro"]);
    const paths = ["/", "/pricing/", "/docs/", "/both/", "/missing/", "/compare/cursor/nested/", "/compare-other/cursor/"];
    expect(datesFor(paths)).toEqual([initialDate, initialDate, initialDate, initialDate, null, null, null]);

    writeSource("src/pages/pricing.astro", "updated pricing page\n");
    commit(templateDate, ["src/pages/pricing.astro"]);
    expect(datesFor(paths)).toEqual([initialDate, templateDate, initialDate, initialDate, null, null, null]);
});

gitTest(needs.title("comparison content supplies dates when the templates have no git history"), () => {
    initRepository();
    commit(contentDate, [comparisonContent]);
    expect(datesFor(["/compare/cursor/", "/compare/", "/pricing/"])).toEqual([contentDate, contentDate, null]);
});

gitTest(needs.title("comparison content alone does not resolve a missing page template"), () => {
    initRepository();
    commit(initialDate);
    unlinkSync(join(site, detailTemplate));
    unlinkSync(join(site, hubTemplate));
    writeSource(comparisonContent, "updated comparison content\n");
    commit(contentDate, [comparisonContent]);
    expect(datesFor(["/compare/cursor/", "/compare/", "/pricing/"])).toEqual([null, null, initialDate]);
});

gitTest(needs.title("an empty git repository returns null for comparison and ordinary routes"), () => {
    initRepository();
    expect(datesFor(["/compare/cursor/", "/compare/", "/pricing/"])).toEqual([null, null, null]);
});

gitTest(needs.title("a site without a git repository returns null"), () => {
    expect(datesFor(["/compare/cursor/", "/compare/", "/pricing/"])).toEqual([null, null, null]);
});

gitTest(needs.title("unavailable git returns null even when source history exists"), () => {
    initRepository();
    commit(initialDate);
    expect(datesFor(["/compare/cursor/", "/compare/", "/pricing/"], { PATH: "" })).toEqual([null, null, null]);
});
