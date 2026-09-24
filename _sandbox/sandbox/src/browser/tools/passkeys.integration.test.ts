import { existsSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { armPasskeys, listPasskeys, upsertPasskey } from "./passkeys.js";

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

test(
    "a passkey enrolled in one browser asserts in the next, carried only by the store",
    async () => {
        if (!(await chromiumInstalled())) {
            return;
        }
        const { chromium } = await import("playwright");
        const store = join(mkdtempSync(join(tmpdir(), "passkeys-")), "npmjs.passkeys.json");
        const site = await serve();
        const saveFailures: unknown[] = [];
        const onSaveFailure = (error: unknown): void => {
            saveFailures.push(error);
        };
        // executablePath is required: a bare headless launch needs the shell the image deletes after installing it.
        const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), args: ["--no-sandbox"] });
        try {
            // Virtual authenticator auto-approves create(); credentialAdded must persist it to the store.
            const first = await browser.newContext();
            const page = await first.newPage();
            await armPasskeys(first, page, store, onSaveFailure);
            await page.goto(site.url);
            const enrolledId = (await page.evaluate(CREATE)) as string;
            await waitFor(async () => expect((await listPasskeys(store)).length).toBe(1));
            const stored = (await listPasskeys(store))[0];
            expect(stored?.rpId).toBe("localhost");
            expect(stored?.isResidentCredential).toBe(true);
            await first.close();

            // Fresh context knows nothing; the store is the only carrier for the discoverable get().
            const second = await browser.newContext();
            const secondPage = await second.newPage();
            await armPasskeys(second, secondPage, store, onSaveFailure);
            await secondPage.goto(site.url);
            expect((await secondPage.evaluate(ASSERT)) as string).toBe(enrolledId);
            // Sign counter must persist forward; a counter that runs backwards reads as a cloned key to relying parties.
            await waitFor(async () => expect((await listPasskeys(store))[0]?.signCount ?? 0).toBeGreaterThan(stored?.signCount ?? 0));
            await second.close();
            expect(saveFailures).toEqual([]);
        } finally {
            await browser.close();
            site.close();
        }
    },
    { timeout: 60_000 },
);

// A credential missing rpId can't go back onto an authenticator; arming must reject instead of silently leaving the key
// absent.
test(
    "a stored credential that Chromium will not take back makes arming reject",
    async () => {
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
            await expect(armPasskeys(context, page, store, () => undefined)).rejects.toThrow(/rpId/);
            // One refused credential must not unplug the authenticator; the origin must be secure, so not about:blank.
            await page.goto(site.url);
            expect(await page.evaluate<boolean>("PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()")).toBe(true);
            await context.close();
        } finally {
            await browser.close();
            site.close();
        }
    },
    { timeout: 60_000 },
);

// Chromium allows only one virtual authenticator per page; re-arming must be a no-op, not swallowed by a
// fire-and-forget catch.
test(
    "arming the same page twice keeps the authenticator, rather than asking for a second",
    async () => {
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
            await armPasskeys(context, page, store, () => undefined);
            await armPasskeys(context, page, store, () => undefined);
            await page.goto(site.url);
            expect(await page.evaluate<boolean>("PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()")).toBe(true);
            await context.close();
        } finally {
            await browser.close();
            site.close();
        }
    },
    { timeout: 60_000 },
);

test("an absent or corrupt store lists no passkeys: the browser still arms", async () => {
    expect(await listPasskeys(join(tmpdir(), "passkeys-never-written.json"))).toEqual([]);
    const corrupt = join(mkdtempSync(join(tmpdir(), "passkeys-")), "x.json");
    await writeFile(corrupt, "{not json");
    expect(await listPasskeys(corrupt)).toEqual([]);
});

// Each stored entry is a private key a site still holds the public half of: an enrollment must never replace a store it
// could not read with a one-entry one.
test("an enrollment over a store this build cannot read sets it aside instead of writing over it", async () => {
    const store = join(mkdtempSync(join(tmpdir(), "passkeys-")), "npmjs.passkeys.json");
    const unreadable = '{"credentials": [{"credentialId": "old", "privateKey": "only-copy"';
    await writeFile(store, unreadable);
    const fresh = { credentialId: "new", isResidentCredential: true, rpId: "npmjs.com", privateKey: "k", signCount: 1 };

    await upsertPasskey(store, fresh);

    expect(await readFile(`${store}.corrupt`, "utf8")).toBe(unreadable);
    expect(await listPasskeys(store)).toEqual([fresh]);
});

test("an enrollment keeps every credential already stored, and merges one it already holds", async () => {
    const store = join(mkdtempSync(join(tmpdir(), "passkeys-")), "npmjs.passkeys.json");
    const kept = { credentialId: "kept", isResidentCredential: true, rpId: "npmjs.com", privateKey: "a", signCount: 3 };
    const bumped = { credentialId: "bumped", isResidentCredential: true, rpId: "github.com", privateKey: "b", signCount: 1 };
    await upsertPasskey(store, kept);
    await upsertPasskey(store, bumped);

    await upsertPasskey(store, { credentialId: "bumped", isResidentCredential: true, privateKey: "b", signCount: 2 });

    expect(await listPasskeys(store)).toEqual([kept, { ...bumped, signCount: 2 }]);
});
