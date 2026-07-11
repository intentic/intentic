import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
