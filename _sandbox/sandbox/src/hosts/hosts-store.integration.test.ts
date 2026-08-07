import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileHostsStore, hostEnrollmentsPath, hostSeedBurnPath, type HostsStore } from "./hosts-store.js";

const tempStore = (): { store: HostsStore; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "hosts-"));
    return { store: fileHostsStore(root), root };
};

test("a pairing enrolls exactly the capability it was minted for", async () => {
    const { store } = tempStore();
    const { token } = store.mintPairing("laptop");
    const enrolled = await store.enroll(token);
    expect(enrolled?.id).toBe("laptop");
    expect(await store.verify(enrolled?.hostToken ?? "")).toBe("laptop");
});

test("a pairing is spent by one enrollment", async () => {
    const { store } = tempStore();
    const { token } = store.mintPairing("laptop");
    expect(await store.enroll(token)).not.toBeUndefined();
    expect(await store.enroll(token)).toBeUndefined();
});

test("an unknown pairing enrolls nothing", async () => {
    const { store } = tempStore();
    expect(await store.enroll("not-a-token")).toBeUndefined();
});

test("re-enrolling a machine rotates its token — the old one stops verifying", async () => {
    const { store } = tempStore();
    const first = await store.enroll(store.mintPairing("laptop").token);
    const second = await store.enroll(store.mintPairing("laptop").token);
    expect(await store.verify(second?.hostToken ?? "")).toBe("laptop");
    expect(await store.verify(first?.hostToken ?? "")).toBeUndefined();
});

test("revoke drops the machine; verify and enrolled both stop reporting it", async () => {
    const { store } = tempStore();
    const enrolled = await store.enroll(store.mintPairing("desktop").token);
    expect(await store.enrolled("desktop")).toBe(true);
    expect(await store.revoke("desktop")).toBe(true);
    expect(await store.revoke("desktop")).toBe(false);
    expect(await store.enrolled("desktop")).toBe(false);
    expect(await store.verify(enrolled?.hostToken ?? "")).toBeUndefined();
});

test("an empty token never verifies — a missing credential must not read as a match", async () => {
    const { store } = tempStore();
    await store.enroll(store.mintPairing("laptop").token);
    expect(await store.verify("")).toBeUndefined();
});

// The file is a key to somebody's computer if it holds tokens — it must hold only digests.
test("the enrollment file stores no usable credential", async () => {
    const { store, root } = tempStore();
    const enrolled = await store.enroll(store.mintPairing("laptop").token);
    const written = await readFile(hostEnrollmentsPath(root), "utf8");
    expect(written).not.toContain(enrolled?.hostToken);
    expect(written).toContain("laptop");
});

/* ---- the setup-time seed ---- */

test("a seeded pairing enrolls the machine the setup named", async () => {
    const { store } = tempStore();
    expect(await store.seedPairing("ada-laptop", "from-the-claim")).toBe(true);
    const enrolled = await store.enroll("from-the-claim");
    expect(enrolled?.id).toBe("ada-laptop");
});

/* THE REPLAY, which is the whole reason this token is treated differently from a browser-minted one. A seeded
 * token lives in the container's environment — in `docker inspect`, in the installer's shell history, and it is
 * replayed verbatim into every rebuilt container. Re-arming it on each boot would turn a setup-time token into a
 * permanent key to an enrollment route that has no bearer check, whose reward is a socket onto somebody's
 * laptop. The burn lives on /history, which outlives the container. */
test("a spent seed never arms again, not even for a fresh daemon on the same history", async () => {
    const { store, root } = tempStore();
    await store.seedPairing("ada-laptop", "from-the-claim");
    expect(await store.enroll("from-the-claim")).not.toBeUndefined();

    // The restart: same /history, same env, a brand-new store.
    const rebooted = fileHostsStore(root);
    expect(await rebooted.seedPairing("ada-laptop", "from-the-claim")).toBe(false);
    expect(await rebooted.enroll("from-the-claim")).toBeUndefined();
});

test("an unspent seed survives a restart, because the machine may not have got to it yet", async () => {
    const { store, root } = tempStore();
    await store.seedPairing("ada-laptop", "from-the-claim");
    // Nothing redeemed it — a laptop that was still installing when the daemon bounced.
    const rebooted = fileHostsStore(root);
    expect(await rebooted.seedPairing("ada-laptop", "from-the-claim")).toBe(true);
    expect((await rebooted.enroll("from-the-claim"))?.id).toBe("ada-laptop");
});

// Re-running the installer mints a FRESH token per claim, so the ordinary "set it up again" path is unaffected
// by the burn — what stops working is replaying one that was already spent.
test("a second setup's token arms even though the first one is burned", async () => {
    const { store, root } = tempStore();
    await store.seedPairing("ada-laptop", "first-claim");
    await store.enroll("first-claim");
    expect(await fileHostsStore(root).seedPairing("ada-laptop", "second-claim")).toBe(true);
});

test("an empty seed is not a pairing", async () => {
    const { store } = tempStore();
    expect(await store.seedPairing("ada-laptop", "")).toBe(false);
    expect(await store.enroll("")).toBeUndefined();
});

// A browser-minted pairing is already unreplayable — nothing outside memory ever held it — so it must not be
// written to the burn list, which would grow a file of digests for no security it does not already have.
test("only a seeded redemption is recorded; a browser-minted one leaves no trace", async () => {
    const { store, root } = tempStore();
    await store.enroll(store.mintPairing("laptop").token);
    const written = await readFile(hostSeedBurnPath(root), "utf8").catch(() => `{"digests":[]}`);
    expect(JSON.parse(written)).toEqual({ digests: [] });
});
