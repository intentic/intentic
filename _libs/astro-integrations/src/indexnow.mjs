// @ts-check
// Submit changed pages to the IndexNow API after each build. Hashes every emitted
// HTML file, compares against a local cache, and POSTs only the URLs that changed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_FILENAME = ".astro-indexnow-cache.json";
const CACHE_METADATA_KEY = "__indexnow";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const INDEXNOW_BATCH_SIZE = 10_000;
const INDEXNOW_PUBLIC_KEY_CHECK_TIMEOUT_MS = 90_000;
const INDEXNOW_PUBLIC_KEY_CHECK_INTERVAL_MS = 3_000;
const INDEXNOW_SUBMISSION_RETRY_DELAY_MS = 3_000;
const INDEXNOW_SUBMISSION_RETRY_COUNT = 5;

function toFsPath(value) {
    if (value instanceof URL) {
        return fileURLToPath(value);
    }

    if (typeof value === "string" && value.startsWith("file:")) {
        return fileURLToPath(new URL(value));
    }

    return value;
}

function normalizeSite(site) {
    if (!site) {
        return null;
    }

    return String(site).replace(/\/+$/, "");
}

function ensureCacheFile(cachePath) {
    const cacheDir = path.dirname(cachePath);

    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    if (!fs.existsSync(cachePath)) {
        fs.writeFileSync(cachePath, "{}", "utf8");
    }
}

function loadCache(cachePath, logger) {
    try {
        return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
        logger.warn("[indexnow] Cache file is unreadable, resetting it.");
        return {};
    }
}

function saveCache(cachePath, data) {
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
}

function hashFile(filePath) {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return `sha256:${hash.digest("hex")}`;
}

function toPublicUrl(site, relativeFilePath) {
    const normalizedPath = relativeFilePath.replace(/\\/g, "/");

    if (normalizedPath === "index.html") {
        return `${site}/`;
    }

    if (normalizedPath.endsWith("/index.html")) {
        return `${site}/${normalizedPath.slice(0, -"index.html".length)}`;
    }

    return `${site}/${normalizedPath}`;
}

function chunk(array, size) {
    const chunks = [];

    for (let index = 0; index < array.length; index += size) {
        chunks.push(array.slice(index, index + size));
    }

    return chunks;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInteger(value, fallback) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }

    const number = Number.parseInt(String(value), 10);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function collectHtmlFiles(rootDir) {
    const files = [];
    const pending = [rootDir];

    while (pending.length > 0) {
        const currentDir = pending.pop();
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                pending.push(fullPath);
                continue;
            }

            if (entry.isFile() && entry.name.endsWith(".html")) {
                files.push(fullPath);
            }
        }
    }

    return files;
}

function validateKeyFile(outDir, key, logger) {
    const keyFilePath = path.join(outDir, `${key}.txt`);

    if (!fs.existsSync(keyFilePath)) {
        logger.warn(`[indexnow] Missing key file "${path.basename(keyFilePath)}" in build output, skipping submission.`);
        return false;
    }

    const keyFileContent = fs.readFileSync(keyFilePath, "utf8");

    if (keyFileContent !== key) {
        logger.warn(
            `[indexnow] Key file must contain exactly the key without extra whitespace. Expected ${Buffer.byteLength(key, "utf8")} bytes, got ${Buffer.byteLength(keyFileContent, "utf8")}. Skipping submission.`,
        );
        return false;
    }

    return true;
}

async function waitForPublicKeyFile({ key, keyLocation, logger, timeoutMs, intervalMs }) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let lastFailureReason = "no response";

    while (Date.now() <= deadline) {
        attempt += 1;

        try {
            const probeUrl = new URL(keyLocation);
            probeUrl.searchParams.set("__indexnow_probe", String(Date.now()));

            const response = await fetch(probeUrl, {
                headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
            });

            if (!response.ok) {
                lastFailureReason = `status ${response.status}`;
            } else {
                const body = await response.text();

                if (body === key) {
                    if (attempt > 1) {
                        logger.info(`[indexnow] Public key file became available after ${attempt} checks.`);
                    }

                    return true;
                }

                lastFailureReason = `unexpected key file contents (${Buffer.byteLength(body, "utf8")} bytes)`;
            }
        } catch {
            lastFailureReason = "network error";
        }

        if (Date.now() + intervalMs > deadline) {
            break;
        }

        if (attempt === 1 || attempt % 5 === 0) {
            logger.info(`[indexnow] Waiting for public key file at ${keyLocation} (${lastFailureReason}).`);
        }

        await sleep(intervalMs);
    }

    logger.warn(
        `[indexnow] Public key file did not become available within ${timeoutMs}ms (${lastFailureReason}). Continuing with submission retries.`,
    );
    return false;
}

async function submitBatch({ batch, batchIndex, batchCount, host, key, keyLocation, logger, retryCount, retryDelayMs }) {
    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
        try {
            const response = await fetch(INDEXNOW_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ host, key, keyLocation, urlList: batch }),
            });

            if (response.ok) {
                return true;
            }

            const responseBody = (await response.text()).trim();
            const canRetry = response.status === 403 || response.status === 429 || response.status >= 500;

            logger.warn(
                `[indexnow] Submission batch ${batchIndex}/${batchCount} attempt ${attempt}/${retryCount} failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}.`,
            );

            if (!canRetry || attempt === retryCount) {
                return false;
            }
        } catch {
            logger.warn(
                `[indexnow] Submission batch ${batchIndex}/${batchCount} attempt ${attempt}/${retryCount} failed because the network request could not be completed.`,
            );

            if (attempt === retryCount) {
                return false;
            }
        }

        await sleep(retryDelayMs * attempt);
    }

    return false;
}

export default function indexNowIntegration(options = {}) {
    let site = null;
    let cachePath = null;

    return {
        name: "indexnow",
        hooks: {
            "astro:config:setup": ({ config }) => {
                site = normalizeSite(options.siteUrl ?? config.site);

                const projectRoot = toFsPath(config.root);
                const cacheDir = options.cacheDir ? path.resolve(projectRoot, options.cacheDir) : projectRoot;

                cachePath = path.join(cacheDir, CACHE_FILENAME);
                ensureCacheFile(cachePath);
            },
            "astro:build:done": async ({ dir, logger }) => {
                if (options.enabled === false) {
                    logger.info("[indexnow] Submission disabled for this build.");
                    return;
                }

                if (!options.key) {
                    logger.warn("[indexnow] Missing key, skipping submission.");
                    return;
                }

                if (!site) {
                    logger.warn("[indexnow] Missing site URL, skipping submission.");
                    return;
                }

                ensureCacheFile(cachePath);

                const outDir = toFsPath(dir);

                if (!validateKeyFile(outDir, options.key, logger)) {
                    return;
                }

                const previousCache = loadCache(cachePath, logger);
                const previousMetadata = previousCache[CACHE_METADATA_KEY] ?? {};
                const keyLocation = `${site}/${options.key}.txt`;
                const forceResubmit =
                    previousMetadata.key !== options.key || previousMetadata.site !== site || previousMetadata.keyLocation !== keyLocation;
                const nextCache = {};
                const changedUrls = [];
                const htmlFiles = collectHtmlFiles(outDir);

                if (forceResubmit) {
                    logger.info("[indexnow] Key or site configuration changed, resubmitting all HTML pages.");
                }

                for (const filePath of htmlFiles) {
                    const relativePath = path.relative(outDir, filePath);
                    const url = toPublicUrl(site, relativePath);
                    const hash = hashFile(filePath);

                    nextCache[url] = hash;

                    if (forceResubmit || previousCache[url] !== hash) {
                        changedUrls.push(url);
                    }
                }

                nextCache[CACHE_METADATA_KEY] = { key: options.key, site, keyLocation };

                if (changedUrls.length === 0) {
                    logger.info("[indexnow] No changed HTML pages detected.");
                    saveCache(cachePath, nextCache);
                    return;
                }

                const batches = chunk(changedUrls, INDEXNOW_BATCH_SIZE);
                logger.info(`[indexnow] Submitting ${changedUrls.length} changed URLs in ${batches.length} batch(es).`);

                const shouldWaitForPublicKeyFile = options.waitForPublicKeyFile ?? process.env.CI === "true";
                const publicKeyCheckTimeoutMs = parsePositiveInteger(
                    options.publicKeyCheckTimeoutMs ?? process.env.INDEXNOW_PUBLIC_KEY_CHECK_TIMEOUT_MS,
                    INDEXNOW_PUBLIC_KEY_CHECK_TIMEOUT_MS,
                );
                const publicKeyCheckIntervalMs = parsePositiveInteger(
                    options.publicKeyCheckIntervalMs ?? process.env.INDEXNOW_PUBLIC_KEY_CHECK_INTERVAL_MS,
                    INDEXNOW_PUBLIC_KEY_CHECK_INTERVAL_MS,
                );
                const submissionRetryCount = parsePositiveInteger(
                    options.submissionRetryCount ?? process.env.INDEXNOW_SUBMISSION_RETRY_COUNT,
                    process.env.CI === "true" ? INDEXNOW_SUBMISSION_RETRY_COUNT : 1,
                );
                const submissionRetryDelayMs = parsePositiveInteger(
                    options.submissionRetryDelayMs ?? process.env.INDEXNOW_SUBMISSION_RETRY_DELAY_MS,
                    INDEXNOW_SUBMISSION_RETRY_DELAY_MS,
                );
                const host = new URL(site).host;

                if (shouldWaitForPublicKeyFile) {
                    await waitForPublicKeyFile({
                        key: options.key,
                        keyLocation,
                        logger,
                        timeoutMs: publicKeyCheckTimeoutMs,
                        intervalMs: publicKeyCheckIntervalMs,
                    });
                }

                let allBatchesSucceeded = true;

                for (const [index, batch] of batches.entries()) {
                    const batchSucceeded = await submitBatch({
                        batch,
                        batchIndex: index + 1,
                        batchCount: batches.length,
                        host,
                        key: options.key,
                        keyLocation,
                        logger,
                        retryCount: submissionRetryCount,
                        retryDelayMs: submissionRetryDelayMs,
                    });

                    if (!batchSucceeded) {
                        allBatchesSucceeded = false;
                    }
                }

                if (!allBatchesSucceeded) {
                    logger.warn("[indexnow] Cache not updated because at least one submission batch failed.");
                    return;
                }

                saveCache(cachePath, nextCache);
            },
        },
    };
}
