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

// WebAuthn requires a secure context and an rpId that is a domain — http://localhost is both, so the page must
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
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
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

        // Browser two: a fresh context knows nothing — the store is the only carrier. Discoverable get() must
        // find the restored credential and answer it.
        const second = await browser.newContext();
        const secondPage = await second.newPage();
        await armPasskeys(second, secondPage, store);
        await secondPage.goto(site.url);
        expect((await secondPage.evaluate(ASSERT)) as string).toBe(enrolledId);
        // The assertion bumped the signature counter, and the bump must land back in the store — a counter that
        // ran backwards is what relying parties read as a cloned key.
        await expect.poll(async () => (await listPasskeys(store))[0]?.signCount ?? 0).toBeGreaterThan(stored?.signCount ?? 0);
        await second.close();
    } finally {
        await browser.close();
        site.close();
    }
});

test("an absent or corrupt store lists no passkeys — the browser still arms", async () => {
    expect(await listPasskeys(join(tmpdir(), "passkeys-never-written.json"))).toEqual([]);
    const corrupt = join(mkdtempSync(join(tmpdir(), "passkeys-")), "x.json");
    await writeFile(corrupt, "{not json");
    expect(await listPasskeys(corrupt)).toEqual([]);
});
