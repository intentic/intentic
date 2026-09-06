import { existsSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { armPasskeys, listPasskeys } from "./passkeys.js";

// The same gate the other browser tests use: without Chromium on disk there is nothing to run a ceremony in.
const chromiumInstalled = async (): Promise<boolean> => {
    try {
        const { chromium } = await import("playwright");
        return existsSync(chromium.executablePath());
    } catch {
        return false;
    }
};

// WebAuthn requires a secure context and an rpId that is a domain: http://localhost is both, so the page must
// be reached as literally "localhost", never 127.0.0.1.
const serve = async (): Promise<{ url: string; close: () => void }> =>
    new Promise((resolve) => {
        const server = createServer((_req, res) => {
            res.setHeader("content-type", "text/html");
            res.end("<title>rp</title>");
        });
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            resolve({ url: `http://localhost:${port}/`, close: () => void server.close() });
        });
    });

// Evaluates travel as strings: the daemon compiles without the DOM lib, and a typed callback would drag
// `navigator` into a node tsconfig for two expressions.
const CREATE = `(async () => {
    const credential = await navigator.credentials.create({ publicKey: {
        challenge: new Uint8Array(32),
        rp: { name: "rp" },
        user: { id: new Uint8Array([1]), name: "owner", displayName: "Owner" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
    }});
    return credential.id;
})()`;

// allowCredentials stays empty on purpose: discovery off the resident key is exactly what a site's
// "use your passkey" button does, so it only succeeds if the restored credential is really on the authenticator.
const ASSERT = `(async () => {
    const credential = await navigator.credentials.get({ publicKey: {
        challenge: new Uint8Array(32),
        userVerification: "required",
        allowCredentials: [],
    }});
    return credential.id;
})()`;

test("a passkey enrolled in one browser asserts in the next, carried only by the store", { timeout: 60_000 }, async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const { chromium } = await import("playwright");
    const store = join(mkdtempSync(join(tmpdir(), "passkeys-")), "npmjs.passkeys.json");
    const site = await serve();
    // executablePath is not optional here: a bare headless launch asks for chromium-headless-shell, and the
    // image deletes that browser right after installing it (Dockerfile, "THE HEADLESS SHELL IS DELETED AGAIN
    // IMMEDIATELY") because every launch the daemon makes names the full browser. This one has to as well:
    // it is also the binary the gate above checked for.
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), args: ["--no-sandbox"] });
    try {
        // Browser one: enroll. The create() ceremony lands on the virtual authenticator with nobody clicking
        // anything (simulated presence/verification), and the credentialAdded event must persist it.
        const first = await browser.newContext();
        const page = await first.newPage();
        await armPasskeys(first, page, store);
        await page.goto(site.url);
        const enrolledId = (await page.evaluate(CREATE)) as string;
        await expect.poll(async () => (await listPasskeys(store)).length).toBe(1);
        const stored = (await listPasskeys(store))[0];
        expect(stored?.rpId).toBe("localhost");
        expect(stored?.isResidentCredential).toBe(true);
        await first.close();

        // Browser two: a fresh context knows nothing, the store is the only carrier. Discoverable get() must
        // find the restored credential and answer it.
        const second = await browser.newContext();
        const secondPage = await second.newPage();
        await armPasskeys(second, secondPage, store);
        await secondPage.goto(site.url);
        expect((await secondPage.evaluate(ASSERT)) as string).toBe(enrolledId);
        // The assertion bumped the signature counter, and the bump must land back in the store: a counter that
        // ran backwards is what relying parties read as a cloned key.
        await expect.poll(async () => (await listPasskeys(store))[0]?.signCount ?? 0).toBeGreaterThan(stored?.signCount ?? 0);
        await second.close();
    } finally {
        await browser.close();
        site.close();
    }
});

/* The failure this file did not have a test for, and the one that cost an afternoon on npm's 2FA page: a stored
 * credential with no rpId cannot go back onto an authenticator, and arming used to swallow that per credential.
 * The account's key was simply absent, every ceremony rejected NotAllowedError, and npm renders that as a
 * "Use security key" button that does nothing when clicked. Arming must say so instead. */
test("a stored credential that Chromium will not take back makes arming reject", { timeout: 60_000 }, async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const { chromium } = await import("playwright");
    const store = join(mkdtempSync(join(tmpdir(), "passkeys-")), "npmjs.passkeys.json");
    // A real EC key, missing only rpId: the exact shape the npmjs store was found holding.
    await writeFile(
        store,
        JSON.stringify({
            credentials: [
                {
                    credentialId: "OPbgIHlrnv2QSQZwTMjEb+UPOd99GNAH+S1X0B5YdzY=",
                    isResidentCredential: false,
                    privateKey:
                        "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUxHGz3Tyil9kbwGc0LYuFhCgvACjES+Upad6lg2GKtShRANCAAQSZHgUOaOaSfdf5ABAF4pi6FLcfzQEI09GMoE4zJXjnd1GKYipeQ8VtlRW48FN00oPCTlVKgEDYULJTLc7rslz",
                    signCount: 5,
                },
            ],
        }),
    );
    const site = await serve();
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), args: ["--no-sandbox"] });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await expect(armPasskeys(context, page, store)).rejects.toThrow(/rpId/);
        // The authenticator is still up: one credential Chromium refused must not unplug the browser, and the
        // page must not be left believing WebAuthn is unavailable. Read from the served origin, because
        // `PublicKeyCredential` exists only in a secure context and about:blank is not one.
        await page.goto(site.url);
        expect(await page.evaluate("PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()")).toBe(true);
        await context.close();
    } finally {
        await browser.close();
        site.close();
    }
});

/* Chromium refuses a second virtual authenticator on a page ("Chrome only supports one internal authenticator
 * per environment"), and every caller arms per page, some of them more than once. Arming the same page twice
 * must be a no-op that keeps the key plugged in, not a refusal swallowed by a fire-and-forget catch. */
test("arming the same page twice keeps the authenticator, rather than asking for a second", { timeout: 60_000 }, async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const { chromium } = await import("playwright");
    const store = join(mkdtempSync(join(tmpdir(), "passkeys-")), "twice.passkeys.json");
    const site = await serve();
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), args: ["--no-sandbox"] });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await armPasskeys(context, page, store);
        await armPasskeys(context, page, store);
        await page.goto(site.url);
        expect(await page.evaluate("PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()")).toBe(true);
        await context.close();
    } finally {
        await browser.close();
        site.close();
    }
});

test("an absent or corrupt store lists no passkeys: the browser still arms", async () => {
    expect(await listPasskeys(join(tmpdir(), "passkeys-never-written.json"))).toEqual([]);
    const corrupt = join(mkdtempSync(join(tmpdir(), "passkeys-")), "x.json");
    await writeFile(corrupt, "{not json");
    expect(await listPasskeys(corrupt)).toEqual([]);
});
