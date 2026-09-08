import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { filePeerStore, type PeerStore } from "./peer-store.js";

// The two files a door keeps on /history, spelled the way the doors spell them.
const peerFiles =
    (stem: string) =>
    (root: string): { enrollments: string; consumed: string } => ({
        enrollments: join(root, `${stem}-enrollments.json`),
        consumed: join(root, `${stem}-pair-consumed.json`),
    });

// Credential half of a peer door: one enrollment per peer, rotated by re-pairing, dropped on revoke; the file holds
// only digests. The last two tests cover what a door can vary: extra fields, and burn-every-pairing.

const spec = { files: peerFiles("host"), key: "hosts", prefix: "iht_", extra: {} };

const tempStore = (): { store: PeerStore<Record<string, never>>; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "peers-"));
    return { store: filePeerStore(root, spec), root };
};

test("a pairing enrolls exactly the id it was minted for, and the token carries the door's prefix", async () => {
    const { store } = tempStore();
    const { token } = store.mintPairing("laptop");
    const enrolled = await store.enroll(token);
    expect(enrolled?.id).toBe("laptop");
    expect(enrolled?.token.startsWith("iht_")).toBe(true);
    expect(await store.verify(enrolled?.token ?? "")).toBe("laptop");
});

test("a pairing is spent by one enrollment, and an unknown one enrolls nothing", async () => {
    const { store } = tempStore();
    const { token } = store.mintPairing("laptop");
    expect(await store.enroll(token)).not.toBeUndefined();
    expect(await store.enroll(token)).toBeUndefined();
    expect(await store.enroll("not-a-token")).toBeUndefined();
});

test("re-enrolling a peer rotates its token: the old one stops verifying", async () => {
    const { store } = tempStore();
    const first = await store.enroll(store.mintPairing("laptop").token);
    const second = await store.enroll(store.mintPairing("laptop").token);
    expect(await store.verify(second?.token ?? "")).toBe("laptop");
    expect(await store.verify(first?.token ?? "")).toBeUndefined();
});

test("revoke drops the peer; verify, enrolled and list all stop reporting it", async () => {
    const { store } = tempStore();
    const enrolled = await store.enroll(store.mintPairing("desktop").token);
    expect(await store.enrolled("desktop")).toBe(true);
    expect(await store.list()).toEqual([{ id: "desktop" }]);
    expect(await store.revoke("desktop")).toBe(true);
    // Revoking again is a no-op that reports false, not an error.
    expect(await store.revoke("desktop")).toBe(false);
    expect(await store.enrolled("desktop")).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.verify(enrolled?.token ?? "")).toBeUndefined();
});

test("a rename carries the enrollment, so the far end's own key keeps working", async () => {
    const { store } = tempStore();
    const enrolled = await store.enroll(store.mintPairing("chrome").token);
    await store.rename("chrome", "personal-chrome");
    expect(await store.verify(enrolled?.token ?? "")).toBe("personal-chrome");
    expect(await store.enrolled("chrome")).toBe(false);
});

test("an empty token never verifies: a missing credential must not read as a match", async () => {
    const { store } = tempStore();
    await store.enroll(store.mintPairing("laptop").token);
    expect(await store.verify("")).toBeUndefined();
});

test("the enrollment file stores no usable credential", async () => {
    const { store, root } = tempStore();
    const enrolled = await store.enroll(store.mintPairing("laptop").token);
    const written = await readFile(join(root, "host-enrollments.json"), "utf8");
    expect(written).not.toContain(enrolled?.token);
    expect(JSON.parse(written)).toMatchObject({ hosts: [{ id: "laptop", hash: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
});

test("a seeded pairing enrolls the peer the setup named", async () => {
    const { store } = tempStore();
    expect(await store.seedPairing("ada-laptop", "from-the-claim")).toBe(true);
    expect((await store.enroll("from-the-claim"))?.id).toBe("ada-laptop");
});

// A seeded token replays verbatim into every rebuilt container; burning it on /history, which outlives the container,
// stops it from re-arming forever.
test("a spent seed never arms again, not even for a fresh daemon on the same history", async () => {
    const { store, root } = tempStore();
    await store.seedPairing("ada-laptop", "from-the-claim");
    expect(await store.enroll("from-the-claim")).not.toBeUndefined();

    // The restart: same /history, same env, a brand-new store.
    const rebooted = filePeerStore(root, spec);
    expect(await rebooted.seedPairing("ada-laptop", "from-the-claim")).toBe(false);
    expect(await rebooted.enroll("from-the-claim")).toBeUndefined();
});

test("an unspent seed survives a restart, because the peer may not have got to it yet", async () => {
    const { store, root } = tempStore();
    await store.seedPairing("ada-laptop", "from-the-claim");
    const rebooted = filePeerStore(root, spec);
    expect(await rebooted.seedPairing("ada-laptop", "from-the-claim")).toBe(true);
    expect((await rebooted.enroll("from-the-claim"))?.id).toBe("ada-laptop");
});

test("a second setup's token arms even though the first one is burned, and an empty seed is not a pairing", async () => {
    const { store, root } = tempStore();
    await store.seedPairing("ada-laptop", "first-claim");
    await store.enroll("first-claim");
    expect(await filePeerStore(root, spec).seedPairing("ada-laptop", "second-claim")).toBe(true);
    expect(await store.seedPairing("ada-laptop", "")).toBe(false);
    expect(await store.enroll("")).toBeUndefined();
});

// A minted pairing never left memory, so recording it would just grow a digest file for no added security.
test("only a seeded redemption is recorded; a minted one at an ordinary door leaves no trace", async () => {
    const { store, root } = tempStore();
    await store.enroll(store.mintPairing("laptop").token);
    const written = await readFile(join(root, "host-pair-consumed.json"), "utf8").catch(() => `{"digests":[]}`);
    expect(JSON.parse(written)).toEqual({ digests: [] });
});

// Burn survives even a fresh mint for the same id; the digest is what's checked, not the id.
test("a replayable door burns every redeemed pairing, so a restart refuses the replayed copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "peers-"));
    const runners = { files: peerFiles("runner"), key: "runners", prefix: "irt_", extra: { host: z.string().optional() }, replayable: true };
    const store = filePeerStore(root, runners);
    const { token } = store.mintPairing("rog-runner");
    expect(await store.enroll(token)).not.toBeUndefined();
    const restarted = filePeerStore(root, runners);
    restarted.mintPairing("rog-runner");
    expect(await restarted.enroll(token)).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, "runner-pair-consumed.json"), "utf8"))).toMatchObject({ digests: [expect.stringMatching(/^[0-9a-f]{64}$/)] });
});

// Extra fields (e.g. a runner's host) are the only way back to the machine that can stop it; the runner itself can't
// supply them.
test("a door's extra record travels from the pairing to the enrollment", async () => {
    const store = filePeerStore(mkdtempSync(join(tmpdir(), "peers-")), { files: peerFiles("runner"), key: "runners", prefix: "irt_", extra: { host: z.string().optional() } });
    expect(await store.enroll(store.mintPairing("rig", { host: "rog" }).token)).toMatchObject({ id: "rig", host: "rog" });
    await store.enroll(store.mintPairing("hand-made").token);
    expect((await store.list()).toSorted((left, right) => left.id.localeCompare(right.id))).toEqual([{ id: "hand-made" }, { id: "rig", host: "rog" }]);
});
