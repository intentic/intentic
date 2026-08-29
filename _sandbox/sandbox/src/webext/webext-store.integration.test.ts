import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileWebExtStore, webextEnrollmentsPath, type WebExtStore } from "./webext-store.js";

/* The credential half of a connected browser: one enrollment per browser, rotated by re-pairing, carried
 * through a rename, and gone for good on revoke.
 *
 * The hosts-store suite retold, minus the seeded-pairing half that has no meaning here (nothing can pre-arm a
 * pairing on somebody's behalf: a person has to click Add in an extension), and plus the one property that is
 * this store's alone — the file holds digests, because a token in it is a socket into a signed-in browser. */

const tempStore = (): { store: WebExtStore; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "webext-"));
    return { store: fileWebExtStore(root), root };
};

test("a pairing enrolls exactly the capability it was minted for", async () => {
    const { store } = tempStore();
    const { token } = store.mintPairing("my-chrome");
    const enrolled = await store.enroll(token);
    expect(enrolled?.id).toBe("my-chrome");
    expect(await store.verify(enrolled?.extensionToken ?? "")).toBe("my-chrome");
});

test("a pairing is spent by one enrollment, and an unknown one enrolls nothing", async () => {
    const { store } = tempStore();
    const { token } = store.mintPairing("my-chrome");
    expect(await store.enroll(token)).not.toBeUndefined();
    expect(await store.enroll(token)).toBeUndefined();
    expect(await store.enroll("not-a-code")).toBeUndefined();
});

// Reinstalling the extension is a clean replacement rather than a second key to the same browser.
test("re-pairing a browser rotates its token: the old one stops verifying", async () => {
    const { store } = tempStore();
    const first = await store.enroll(store.mintPairing("my-chrome").token);
    const second = await store.enroll(store.mintPairing("my-chrome").token);
    expect(await store.verify(second?.extensionToken ?? "")).toBe("my-chrome");
    expect(await store.verify(first?.extensionToken ?? "")).toBeUndefined();
});

test("revoke drops the browser; verify and enrolled both stop reporting it", async () => {
    const { store } = tempStore();
    const enrolled = await store.enroll(store.mintPairing("work-edge").token);
    expect(await store.enrolled("work-edge")).toBe(true);
    expect(await store.revoke("work-edge")).toBe(true);
    expect(await store.enrolled("work-edge")).toBe(false);
    expect(await store.verify(enrolled?.extensionToken ?? "")).toBeUndefined();
    // Revoking something that was never there is not an error, it is a no-op that says so.
    expect(await store.revoke("work-edge")).toBe(false);
});

// A rename must not mean walking to another machine and re-pairing a browser that never changed.
test("a rename carries the enrollment, so the extension's own key keeps working", async () => {
    const { store } = tempStore();
    const enrolled = await store.enroll(store.mintPairing("chrome").token);
    await store.rename("chrome", "personal-chrome");
    expect(await store.verify(enrolled?.extensionToken ?? "")).toBe("personal-chrome");
    expect(await store.enrolled("chrome")).toBe(false);
});

test("an empty token verifies as nobody, whatever is enrolled", async () => {
    const { store } = tempStore();
    await store.enroll(store.mintPairing("my-chrome").token);
    expect(await store.verify("")).toBeUndefined();
});

/* WHAT IS ON DISK. A key to somebody's signed-in browser, so the file records that an enrollment exists and
 * holds nothing that could be used to present it. */
test("the enrollment file holds digests, never the token itself", async () => {
    const { store, root } = tempStore();
    const enrolled = await store.enroll(store.mintPairing("my-chrome").token);
    const stored = await readFile(webextEnrollmentsPath(root), "utf8");
    expect(stored).not.toContain(enrolled?.extensionToken ?? "never");
    expect(stored).toContain("my-chrome");
    expect(JSON.parse(stored)).toMatchObject({ browsers: [{ id: "my-chrome", hash: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
});
