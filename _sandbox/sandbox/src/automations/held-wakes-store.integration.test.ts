import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestUnreadableError } from "../store/json-file.js";
import type { AutomationApproval } from "@intentic/sandbox-contract/schemas/automations";
import { fileHeldWakesStore, HeldWakeNotApproved, type ReleasedWake } from "./held-wakes-store.js";

// The queue of wakes held for a person, over real files under a temp history root: where a hold sits, who can let it out,
// and what happens to a file in the queue that is not what the daemon wrote.

const historyRoot = (): string => mkdtempSync(join(tmpdir(), "held-wakes-"));
const queueOf = (root: string): string => join(root, "automation-holds");
const decisions = async (root: string): Promise<Record<string, { digest: string; approver?: string }>> =>
    JSON.parse(await readFile(join(root, "approval-decisions.json"), "utf8")).approved;

// What a release hands back is the hold, branded as released; the brand is not part of what is being compared.
const plain = (released: ReleasedWake | undefined): AutomationApproval | undefined => released;

test("add mints an id and persists the payload; list is oldest-first; get and remove round-trip", async () => {
    const root = historyRoot();
    const store = fileHeldWakesStore(root);
    expect(await store.list()).toEqual([]);

    const first = await store.add({ automationId: "inbox", payload: "ping", createdAt: 1 });
    const second = await store.add({ automationId: "inbox", createdAt: 2 });
    expect(first.id).not.toBe(second.id);

    // Sorted by createdAt ascending; the payload snapshot survives the round-trip, absent when not given.
    expect((await store.list()).map((item) => [item.createdAt, item.payload])).toEqual([
        [1, "ping"],
        [2, undefined],
    ]);
    expect(await store.get(first.id)).toEqual(first);
    // On the history volume, one file each, and nothing but the hold's own fields in it.
    expect(JSON.parse(await readFile(join(queueOf(root), `${first.id}.json`), "utf8"))).toEqual({ automationId: "inbox", payload: "ping", createdAt: 1 });

    expect(await store.remove(first.id)).toBe(true);
    expect(await store.remove(first.id)).toBe(false);
    expect((await store.list()).map((item) => item.id)).toEqual([second.id]);
});

describe("the owner's release", () => {
    test("lets a hold out only on a yes recorded against it, and spends the yes with it", async () => {
        const root = historyRoot();
        const store = fileHeldWakesStore(root);
        const held = await store.add({ automationId: "inbox", payload: "ping", createdAt: 1 });

        // No yes on record: the hold stays where it is.
        await expect(store.release(held.id)).rejects.toThrow(HeldWakeNotApproved);
        expect(await store.list()).toEqual([held]);

        expect(await store.approve(held.id, "ada@acme.dev")).toBe(true);
        expect(Object.keys(await decisions(root))).toEqual([`wake:${held.id}`]);
        expect((await decisions(root))[`wake:${held.id}`]?.approver).toBe("ada@acme.dev");

        expect(plain(await store.release(held.id))).toEqual(held);
        expect(await store.list()).toEqual([]);
        // One yes runs once: it left the ledger with the hold, and a second release finds nothing to let out.
        expect(await decisions(root)).toEqual({});
        expect(await store.release(held.id)).toBeUndefined();
    });

    test("a hold changed after the yes is not let out on it", async () => {
        const root = historyRoot();
        const store = fileHeldWakesStore(root);
        const held = await store.add({ automationId: "inbox", payload: "ping", createdAt: 1 });
        await store.approve(held.id, "ada@acme.dev");

        // Whatever writes the queue after the owner said yes, it is a different hold from the one they approved.
        await writeFile(join(queueOf(root), `${held.id}.json`), JSON.stringify({ automationId: "inbox", payload: "rm -rf everything", createdAt: 1 }));

        await expect(store.release(held.id)).rejects.toThrow(`the owner's yes for it does not stand for it as it is now`);
        expect((await store.list()).map((item) => item.payload)).toEqual(["rm -rf everything"]);
    });

    test("one hold's yes is not another's", async () => {
        const store = fileHeldWakesStore(historyRoot());
        const first = await store.add({ automationId: "inbox", createdAt: 1 });
        const second = await store.add({ automationId: "inbox", createdAt: 2 });
        await store.approve(first.id, undefined);

        await expect(store.release(second.id)).rejects.toThrow(HeldWakeNotApproved);
        expect(plain(await store.release(first.id))).toEqual(first);
    });

    test("a hold nobody holds any more is nothing to approve, and a stale yes for it is dropped", async () => {
        const root = historyRoot();
        const store = fileHeldWakesStore(root);
        const held = await store.add({ automationId: "inbox", createdAt: 1 });
        await store.approve(held.id, "ada@acme.dev");
        // Rejected after the yes was recorded: the hold goes, and the yes does not outlive it.
        expect(await store.remove(held.id)).toBe(true);
        expect(await decisions(root)).toEqual({});

        expect(await store.approve(held.id, "ada@acme.dev")).toBe(false);
        expect(await store.release(held.id)).toBeUndefined();
    });

    test("a ledger of yeses this build cannot read lets nothing out", async () => {
        const root = historyRoot();
        const store = fileHeldWakesStore(root);
        const held = await store.add({ automationId: "inbox", createdAt: 1 });
        await store.approve(held.id, "ada@acme.dev");
        await writeFile(join(root, "approval-decisions.json"), "{ not json");

        await expect(store.release(held.id)).rejects.toThrow("cannot be read");
        expect(await store.list()).toEqual([held]);
    });
});

describe("a countdown hold", () => {
    test("is the daemon's to release once its time comes, and not before", async () => {
        const store = fileHeldWakesStore(historyRoot());
        const held = await store.add({ automationId: "fixer", payload: "checks broke", createdAt: 1, autoRunAt: 5_000 });
        expect(held.autoRunAt).toBe(5_000);
        expect((await store.list())[0]?.autoRunAt).toBe(5_000);

        expect(await store.releaseCountdown(held.id, 4_999)).toBeUndefined();
        expect(await store.list()).toEqual([held]);
        expect(plain(await store.releaseCountdown(held.id, 5_000))).toEqual(held);
        expect(await store.list()).toEqual([]);
        expect(await store.releaseCountdown(held.id, 9_000)).toBeUndefined();
    });

    test("is never honoured on a hold the daemon did not queue: it waits for a person", async () => {
        const root = historyRoot();
        const store = fileHeldWakesStore(root);
        await mkdir(queueOf(root), { recursive: true });
        // What an agent would write: a valid hold whose deadline has long passed, signed by nobody.
        await writeFile(join(queueOf(root), "planted.json"), JSON.stringify({ automationId: "fixer", payload: "rm -rf /work", createdAt: 1, autoRunAt: 2 }));
        // And one signed with a signature the daemon never made.
        await writeFile(join(queueOf(root), "forged.json"), JSON.stringify({ automationId: "fixer", payload: "rm -rf /work", createdAt: 1, autoRunAt: 2, mint: "0".repeat(64) }));

        expect((await store.list()).map((item) => [item.id, item.autoRunAt, "mint" in item]).toSorted()).toEqual([
            ["forged", undefined, false],
            ["planted", undefined, false],
        ]);
        expect(await store.releaseCountdown("planted", Date.now())).toBeUndefined();
        expect(await store.releaseCountdown("forged", Date.now())).toBeUndefined();
        // Still queued, for the owner to approve or reject.
        expect((await store.list()).map((item) => item.id).toSorted()).toEqual(["forged", "planted"]);
    });

    test("an edited deadline or payload voids the signature, so the hold waits for a person", async () => {
        const root = historyRoot();
        const store = fileHeldWakesStore(root);
        const held = await store.add({ automationId: "fixer", payload: "checks broke", createdAt: 1, autoRunAt: 5_000 });
        const file = join(queueOf(root), `${held.id}.json`);
        const written = JSON.parse(await readFile(file, "utf8"));

        await writeFile(file, JSON.stringify({ ...written, autoRunAt: 1 }));
        expect((await store.list())[0]?.autoRunAt).toBeUndefined();
        expect(await store.releaseCountdown(held.id, 9_000)).toBeUndefined();

        await writeFile(file, JSON.stringify({ ...written, payload: "something else" }));
        expect((await store.list())[0]?.autoRunAt).toBeUndefined();
        expect(await store.releaseCountdown(held.id, 9_000)).toBeUndefined();
    });

    test("another sandbox's signature does not carry: the key stays with the sandbox that made it", async () => {
        const elsewhere = historyRoot();
        const held = await fileHeldWakesStore(elsewhere).add({ automationId: "fixer", createdAt: 1, autoRunAt: 5_000 });
        const copied = await readFile(join(queueOf(elsewhere), `${held.id}.json`), "utf8");

        const here = historyRoot();
        await mkdir(queueOf(here), { recursive: true });
        await writeFile(join(queueOf(here), `${held.id}.json`), copied);
        const store = fileHeldWakesStore(here);

        expect((await store.list())[0]?.autoRunAt).toBeUndefined();
        expect(await store.releaseCountdown(held.id, 9_000)).toBeUndefined();
    });

    test("the owner can still release it ahead of its time, and then it does not release a second time", async () => {
        const store = fileHeldWakesStore(historyRoot());
        const held = await store.add({ automationId: "fixer", createdAt: 1, autoRunAt: 5_000 });
        await store.approve(held.id, "ada@acme.dev");
        expect(plain(await store.release(held.id))).toEqual(held);
        expect(await store.releaseCountdown(held.id, 9_000)).toBeUndefined();
    });
});

describe("a file in the queue this build cannot read", () => {
    test("is reported by name, never dropped, never run, and never deleted", async () => {
        const root = historyRoot();
        const store = fileHeldWakesStore(root);
        const held = await store.add({ automationId: "inbox", createdAt: 1 });
        await writeFile(join(queueOf(root), "torn.json"), "{ not json");
        await writeFile(join(queueOf(root), "odd.json"), JSON.stringify({ automationId: 7 }));

        expect(await store.read()).toEqual({ wakes: [held], unreadable: ["odd.json", "torn.json"] });
        expect(await store.list()).toEqual([held]);
        await expect(store.get("torn")).rejects.toThrow(ManifestUnreadableError);
        await expect(store.approve("torn", "ada@acme.dev")).rejects.toThrow(ManifestUnreadableError);
        await expect(store.release("torn")).rejects.toThrow(ManifestUnreadableError);
        expect((await readdir(queueOf(root))).toSorted()).toEqual([`${held.id}.json`, "odd.json", "torn.json"].toSorted());
    });

    test("a queue that was never written is empty, not unreadable", async () => {
        expect(await fileHeldWakesStore(historyRoot()).read()).toEqual({ wakes: [], unreadable: [] });
    });
});

test("a signing key that cannot be read leaves the queue listing, with every countdown waiting for a person, and says so", async () => {
    const root = historyRoot();
    const warned: string[] = [];
    const held = await fileHeldWakesStore(root).add({ automationId: "fixer", createdAt: 1, autoRunAt: 5_000 });
    // The key exists but is not a file this build can read: it is never replaced, since every signature stands on it.
    await rm(join(root, "automation-holds.key"));
    await mkdir(join(root, "automation-holds.key"));

    const store = fileHeldWakesStore(root, (message) => warned.push(message));
    expect((await store.list()).map((hold) => [hold.id, hold.autoRunAt])).toEqual([[held.id, undefined]]);
    expect(await store.releaseCountdown(held.id, 9_000)).toBeUndefined();
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("the key that signs a countdown could not be read");
});
