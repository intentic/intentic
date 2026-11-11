import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionEnvelope } from "@intentic/sandbox-contract/schemas/connection-hub";
import pino from "pino";
import type { Services } from "../composition.js";
import { createHubReconciler } from "./hub-reconcile.js";
import { fileHubStore } from "./hub-store.js";

// What the hub made here follows the entries shared here: made once, made again over itself when the entry changes, and
// taken away when the computer stops sharing it, unless it was this sandbox's own before the hub held it.

interface DevinRow {
    readonly id: string;
    readonly apiKey: string;
    readonly label?: string;
    readonly connectedAt: number;
}

const devinEnvelope = (apiKey: string): string =>
    JSON.stringify({
        intentic: "connection",
        v: 1,
        label: "Devin",
        from: { sandbox: "laptop", at: 1 },
        item: { type: "account", provider: "devin", account: { apiKey, label: "Devin (work)" } },
    } satisfies ConnectionEnvelope);

// SAFETY: the reconciler reaches only the members each test fakes for an account entry, with the shapes it reads.
const fakeServices = (members: object): Services => members as Services;

const world = async () => {
    const copies: Record<string, string> = {};
    const devin = new Map<string, DevinRow>();
    const audited: string[] = [];
    const members = {
        keyringCopies: { all: async () => ({ ...copies }) },
        keyringLink: { pointer: async () => ({ machine: "rog" }) },
        audit: { record: (event: { readonly action: string }) => audited.push(event.action) },
        devinStore: {
            list: async () => [...devin.values()].map((row) => ({ id: row.id, label: row.label ?? "Devin", connectedAt: row.connectedAt })),
            read: async (id: string) => devin.get(id),
            write: async (row: DevinRow) => {
                devin.set(row.id, row);
            },
            clear: async (id: string) => {
                devin.delete(id);
            },
        },
        devinModels: { forget: () => undefined },
        headroom: { clear: async () => undefined },
        providerRefusals: { drop: async () => undefined },
    };
    const services = fakeServices(members);
    const store = fileHubStore(join(await mkdtemp(join(tmpdir(), "hub-")), "connection-hub.json"));
    const reconcile = createHubReconciler({ store, logger: pino({ level: "silent" }), whole: () => services });
    return { copies, devin, audited, store, reconcile };
};

test("a shared key becomes an account here, follows its entry's changes, and goes when the entry is no longer shared", async () => {
    const { copies, devin, audited, store, reconcile } = await world();
    copies["CONNECTION_DEVIN_AB12"] = devinEnvelope("key-1");
    await reconcile();
    expect([...devin.values()].map((row) => row.apiKey)).toEqual(["key-1"]);
    const [id = ""] = [...devin.keys()];

    await reconcile();
    expect(audited.filter((action) => action === "hub.take")).toHaveLength(1);

    copies["CONNECTION_DEVIN_AB12"] = devinEnvelope("key-2");
    await reconcile();
    expect(devin.size).toBe(1);
    expect(devin.get(id)?.apiKey).toBe("key-2");

    delete copies["CONNECTION_DEVIN_AB12"];
    await reconcile();
    expect(devin.size).toBe(0);
    expect((await store.read()).seen).toEqual([]);
});

test("a connection this sandbox saved stays when the computer stops sharing it back", async () => {
    const { copies, devin, store, reconcile } = await world();
    devin.set("own", { id: "own", apiKey: "key-1", connectedAt: 1 });
    const value = devinEnvelope("key-1");
    copies["CONNECTION_DEVIN_CD34"] = value;
    await store.update(() => ({
        saved: [{ target: { type: "account", provider: "devin", id: "own" }, entry: "CONNECTION_DEVIN_CD34", machine: "rog", at: 1, pending: false }],
        seen: [],
    }));
    await reconcile();
    expect((await store.read()).seen.map((seen) => seen.made)).toEqual([false]);

    delete copies["CONNECTION_DEVIN_CD34"];
    await reconcile();
    expect([...devin.keys()]).toEqual(["own"]);
});

test("an entry that is not a connection is reported, not made", async () => {
    const { copies, devin, store, reconcile } = await world();
    copies["CONNECTION_ODD_EF56"] = "hunter2";
    await reconcile();
    expect(devin.size).toBe(0);
    expect((await store.read()).seen.map((seen) => seen.failure)).toEqual(["It is not a connection this sandbox can read."]);
});
