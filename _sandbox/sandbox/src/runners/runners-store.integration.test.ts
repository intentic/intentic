import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileRunnersStore, type RunnersStore } from "./runners-store.js";

// The hosts-store suite retold for the runner pairing, plus the one rule this store tightens: EVERY redeemed
// pairing is burned on /history, because a runner's pairing always lives in a container's env and is
// replayed verbatim into every rebuild — a restart of the PARENT daemon must not make it spendable again.

const tempStore = (): { store: RunnersStore; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "runners-"));
    return { store: fileRunnersStore(root), root };
};

test("a pairing enrolls exactly the runner it was minted for", async () => {
    const { store } = tempStore();
    const { token } = store.mintPairing("rog-runner");
    const enrolled = await store.enroll(token);
    expect(enrolled?.id).toBe("rog-runner");
    expect(await store.verify(enrolled?.runnerToken ?? "")).toBe("rog-runner");
    expect(await store.list()).toEqual([{ id: "rog-runner" }]);
});

test("a pairing is spent by one enrollment, and stays spent across a parent restart", async () => {
    const { store, root } = tempStore();
    const { token } = store.mintPairing("rog-runner");
    expect(await store.enroll(token)).not.toBeUndefined();
    expect(await store.enroll(token)).toBeUndefined();
    // The burn is on /history: a fresh store over the same root (the parent daemon restarting) refuses the
    // replayed env copy even after someone re-mints a pairing that happens to collide — the digest decides.
    const restarted = fileRunnersStore(root);
    restarted.mintPairing("rog-runner");
    expect(await restarted.enroll(token)).toBeUndefined();
});

test("re-pairing a runner rotates its token: the old one stops verifying", async () => {
    const { store } = tempStore();
    const first = await store.enroll(store.mintPairing("rog-runner").token);
    const second = await store.enroll(store.mintPairing("rog-runner").token);
    expect(await store.verify(second?.runnerToken ?? "")).toBe("rog-runner");
    expect(await store.verify(first?.runnerToken ?? "")).toBeUndefined();
});

test("revoke drops the runner; verify, enrolled and list all stop reporting it", async () => {
    const { store } = tempStore();
    const enrolled = await store.enroll(store.mintPairing("fly-1").token);
    expect(await store.enrolled("fly-1")).toBe(true);
    expect(await store.revoke("fly-1")).toBe(true);
    expect(await store.revoke("fly-1")).toBe(false);
    expect(await store.enrolled("fly-1")).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.verify(enrolled?.runnerToken ?? "")).toBeUndefined();
});

/* WHICH MACHINE HOLDS IT, carried from the pairing onto the enrollment: it is the only way back to the
 * computer that can stop or remove the container, and the runner itself cannot supply it (from inside, a
 * container knows its hostname and nothing about the capability its host is filed under). */
test("a runner remembers the computer that was asked to create it, and one made by hand simply has none", async () => {
    const { store } = tempStore();
    await store.enroll(store.mintPairing("rig", "rog").token);
    await store.enroll(store.mintPairing("hand-made").token);
    expect((await store.list()).toSorted((left, right) => left.id.localeCompare(right.id))).toEqual([{ id: "hand-made" }, { id: "rig", host: "rog" }]);
});
