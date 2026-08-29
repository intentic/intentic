// Submits changed pages to IndexNow after a production deploy. Runs at the end of the Cloudflare build
// command (after wrangler deploy), not during astro build: astro-indexnow fires at build:done while the
// upload is still ahead, so the first build after a key rotation can 403 against the old live key file.
//
// Waits for the key file to answer on the live site before submitting, retries 403 (Bing sometimes refuses
// until the new key has been live for a minute), and emits trailing-slash URLs to match trailingSlash:
// "always". The cache remains a local, ignored build artifact so deployment state never dirties or
// conflicts with the source tree.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const BATCH_SIZE = 10_000;
const KEY = process.env.INDEXNOW_KEY ?? "9a4a1feb8dbf739faffa0b6c035b521b";
const SITE = (process.env.INDEXNOW_SITE ?? "https://intentic.dev").replace(/\/$/, "");
const HOST = new URL(SITE).host;
const KEY_URL = `${SITE}/${KEY}.txt`;
const CACHE = path.join(import.meta.dirname, "..", ".astro-indexnow-cache.json");

const RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 2000;
const KEY_POLL_MS = 3000;
const KEY_POLL_MAX_MS = 90_000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashFile(filePath) {
    return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function loadCache() {
    try {
        const parsed = JSON.parse(fs.readFileSync(CACHE, "utf8"));
        if (parsed?.version === 1 && typeof parsed.entries === "object") {
            return parsed.entries;
        }
        return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
        return {};
    }
}

function saveCache(entries) {
    fs.writeFileSync(CACHE, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
}

/** Canonical URL for a built page: trailing slash everywhere except the site root. */
function pageUrl(relativeDir) {
    const pathname = relativeDir === "" || relativeDir === "." ? "/" : `/${relativeDir.replace(/\/$/, "")}/`;
    return new URL(pathname, `${SITE}/`).href;
}

function walkHtml(outDir, onPage) {
    function walk(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && entry.name === "index.html") {
                const relative = path
                    .relative(outDir, full)
                    .replace(/index\.html$/, "")
                    .replace(/\\/g, "/");
                onPage(full, relative);
            }
        }
    }
    walk(outDir);
}

async function keyIsLive() {
    try {
        const response = await fetch(KEY_URL, { redirect: "manual" });
        if (response.status !== 200) {
            return false;
        }
        return (await response.text()).trim() === KEY;
    } catch {
        return false;
    }
}

async function waitForKey() {
    const deadline = Date.now() + KEY_POLL_MAX_MS;
    while (Date.now() < deadline) {
        if (await keyIsLive()) {
            return true;
        }
        await sleep(KEY_POLL_MS);
    }
    return false;
}

function isRetryable(status) {
    return status === 403 || status === 429 || (status >= 500 && status < 600);
}

async function submitBatch(urls) {
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        const response = await fetch(INDEXNOW_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_URL, urlList: urls }),
        });

        if (response.ok) {
            return true;
        }

        const body = await response.text();
        if (!isRetryable(response.status) || attempt === RETRY_ATTEMPTS) {
            console.warn(`[indexnow] batch failed (${response.status}): ${body}`);
            return false;
        }

        const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), 30_000);
        console.warn(`[indexnow] batch attempt ${attempt} failed (${response.status}), retrying in ${delay}ms`);
        await sleep(delay);
    }
    return false;
}

export async function submitIndexNow({ outDir = path.join(import.meta.dirname, "..", "dist") } = {}) {
    if (process.env.INDEXNOW_ENABLED === "0") {
        console.info("[indexnow] disabled");
        return;
    }

    if (!fs.existsSync(outDir)) {
        throw new Error(`[indexnow] build output not found: ${outDir}`);
    }

    console.info("[indexnow] waiting for key file on live site…");
    if (!(await waitForKey())) {
        console.warn(`[indexnow] key file not live at ${KEY_URL} after ${KEY_POLL_MAX_MS / 1000}s, skipping submission`);
        return;
    }

    const previous = loadCache();
    const next = {};
    const changed = [];

    walkHtml(outDir, (filePath, relative) => {
        const url = pageUrl(relative);
        const hash = hashFile(filePath);
        next[url] = hash;
        if (previous[url] !== hash) {
            changed.push(url);
        }
    });

    if (changed.length === 0) {
        console.info("[indexnow] no changed URLs");
        saveCache(next);
        return;
    }

    console.info(`[indexnow] submitting ${changed.length} changed URL(s)`);

    for (let i = 0; i < changed.length; i += BATCH_SIZE) {
        const batch = changed.slice(i, i + BATCH_SIZE);
        const ok = await submitBatch(batch);
        if (!ok) {
            console.warn("[indexnow] submission failed; cache left unchanged");
            return;
        }
    }

    saveCache(next);
    console.info("[indexnow] submission complete");
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
    submitIndexNow().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
