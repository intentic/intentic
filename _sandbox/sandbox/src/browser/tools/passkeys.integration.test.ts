import { existsSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { armPasskeys, listPasskeys } from "./passkeys.js";

// Skips when Chromium isn't installed on disk.
const chromiumInstalled = async (): Promise<boolean> => {
    try {
        const { chromium } = await import("playwright");
        return existsSync(chromium.executablePath());
    } catch {
        return false;
    }
};

// WebAuthn needs a secure context and a domain rpId: served as literally "localhost", never 127.0.0.1.
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

// Evaluated as a string: the daemon compiles without DOM lib types.
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

// Empty allowCredentials forces discovery off the resident key, like a site's real "use your passkey" button.
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
    // executablePath is required: a bare headless launch needs the shell the image deletes after installing it.
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), args: ["--no-sandbox"] });
    try {
        // Virtual authenticator auto-approves create(); credentialAdded must persist it to the store.
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

        // Fresh context knows nothing; the store is the only carrier for the discoverable get().
        const second = await browser.newContext();
        const secondPage = await second.newPage();
        await armPasskeys(second, secondPage, store);
        await secondPage.goto(site.url);
        expect((await secondPage.evaluate(ASSERT)) as string).toBe(enrolledId);
        // Sign counter must persist forward; a counter that runs backwards reads as a cloned key to relying parties.
        await expect.poll(async () => (await listPasskeys(store))[0]?.signCount ?? 0).toBeGreaterThan(stored?.signCount ?? 0);
        await second.close();
    } finally {
        await browser.close();
        site.close();
    }
});

// A credential missing rpId can't go back onto an authenticator; arming must reject instead of silently leaving the key
// absent.
test("a stored credential that Chromium will not take back makes arming reject", { timeout: 60_000 }, async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const { chromium } = await import("playwright");
    const store = join(mkdtempSync(join(tmpdir(), "passkeys-")), "npmjs.passkeys.json");
    // A real EC key, missing only rpId.
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
        // One refused credential must not unplug the authenticator; the origin must be secure, so not about:blank.
        await page.goto(site.url);
        expect(await page.evaluate("PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()")).toBe(true);
        await context.close();
    } finally {
        await browser.close();
        site.close();
    }
});

// Chromium allows only one virtual authenticator per page; re-arming must be a no-op, not swallowed by a
// fire-and-forget catch.
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
