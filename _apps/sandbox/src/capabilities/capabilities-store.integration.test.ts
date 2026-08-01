import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { type CapabilitiesStore, fileCapabilitiesStore } from "./capabilities-store.js";

// A store over a fresh temp path (the .intentic dir doesn't exist yet — the store must create it on write).
const tempStore = (): { store: CapabilitiesStore; path: string } => {
    const path = join(mkdtempSync(join(tmpdir(), "caps-")), ".intentic", "capabilities.json");
    return { store: fileCapabilitiesStore(path), path };
};

const mcp = (id: string, url: string): Capability => ({ id, kind: "mcp", config: { url } });

test("upsert appends, then edits by id; list + get reflect it without duplicating", async () => {
    const { store } = tempStore();
    expect(await store.list()).toEqual([]);
    await store.upsert(mcp("linear", "https://a/mcp"));
    await store.upsert(mcp("sentry", "https://b/mcp"));
    expect((await store.list()).map((capability) => capability.id)).toEqual(["linear", "sentry"]);
    // Re-upserting the same id edits in place.
    await store.upsert(mcp("linear", "https://edited/mcp"));
    expect(await store.get("linear")).toEqual({ id: "linear", kind: "mcp", config: { url: "https://edited/mcp" } });
    expect(await store.list()).toHaveLength(2);
});

test("remove returns true when present, false when absent", async () => {
    const { store } = tempStore();
    await store.upsert(mcp("linear", "https://a/mcp"));
    expect(await store.remove("linear")).toBe(true);
    expect(await store.remove("linear")).toBe(false);
    expect(await store.list()).toEqual([]);
});

test("a corrupt or schema-invalid manifest reads as empty rather than throwing", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not valid json");
    expect(await store.list()).toEqual([]);
    // Valid JSON, wrong shape (unknown kind) → dropped, not thrown.
    await writeFile(path, JSON.stringify([{ id: "x", kind: "bogus", config: {} }]));
    expect(await store.list()).toEqual([]);
});

test("ONE unreadable entry never takes the rest of the manifest down with it", async () => {
    // The regression that made a rebuild loop: parsing the file as z.array(CapabilitySchema) returned an EMPTY
    // manifest for any single bad entry, so a capability whose config shape changed under it silently erased
    // devops, docker and every mcp connector too — and the composed overlay collapsed to a bare FROM, which the
    // Environment card then asked the owner to rebuild.
    const invalid: string[] = [];
    const path = join(mkdtempSync(join(tmpdir(), "caps-")), ".intentic", "capabilities.json");
    const store = fileCapabilitiesStore(path, (id) => invalid.push(id));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
        path,
        JSON.stringify([
            { id: "devops", kind: "devops", config: {} },
            // A vpn entry in the shape that predates the provider union — unreadable by this daemon.
            { id: "office", kind: "vpn", config: { config: "[Interface]\n", enabled: "on" } },
            { id: "linear", kind: "mcp", config: { url: "https://a/mcp" } },
        ]),
    );

    expect((await store.list()).map((capability) => capability.id)).toEqual(["devops", "linear"]);
    // The drop is reported, never silent — a capability vanishing from the UI must be diagnosable.
    expect(invalid).toEqual(["office"]);
});

test("an unreadable entry survives writes instead of being quietly deleted", async () => {
    // The stale entry is the user's data (a VPN's credentials). A daemon that cannot read it must not be the
    // thing that destroys it on the next unrelated upsert.
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    const stale = { id: "office", kind: "vpn", config: { config: "[Interface]\n", enabled: "on" } };
    await writeFile(path, JSON.stringify([stale]));

    await store.upsert(mcp("linear", "https://a/mcp"));
    const onDisk = JSON.parse(await readFile(path, "utf8")) as unknown[];
    expect(onDisk).toContainEqual(stale);
    expect(await store.list()).toHaveLength(1);

    // And it is still addressable: re-adding that id (the fix path) replaces it rather than duplicating.
    await store.upsert({ id: "office", kind: "vpn", config: { provider: "wireguard", config: "[Interface]\n", autoConnect: "on" } });
    expect(JSON.parse(await readFile(path, "utf8")) as unknown[]).toHaveLength(2);
    expect((await store.list()).map((capability) => capability.id)).toEqual(["linear", "office"]);
});

test("removing an unreadable entry works — the escape hatch when re-adding isn't wanted", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify([{ id: "office", kind: "vpn", config: { config: "[Interface]\n", enabled: "on" } }]));
    expect(await store.remove("office")).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")) as unknown[]).toEqual([]);
});
