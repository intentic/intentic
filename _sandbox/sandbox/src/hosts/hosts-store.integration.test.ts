import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileHostsStore, hostEnrollmentsPath, type HostsStore } from "./hosts-store.js";

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
