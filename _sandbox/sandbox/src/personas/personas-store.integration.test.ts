import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { Persona } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { filePersonasStore, type PersonasStore } from "./personas-store.js";

// A store over a fresh temp path (the .intentic dir doesn't exist yet — the store must create it on write).
const tempStore = (): { store: PersonasStore; path: string } => {
    const path = join(mkdtempSync(join(tmpdir(), "personas-")), `${STATE_DIR}`, "personas.json");
    return { store: filePersonasStore(path), path };
};

const card = (id: string, capabilities: readonly string[]): Persona => ({ id, capabilities: [...capabilities] });

test("upsert appends, then edits by id; list + get reflect it without duplicating", async () => {
    const { store } = tempStore();
    expect(await store.list()).toEqual([]);
    await store.upsert(card("work", ["reddit-work"]));
    await store.upsert(card("personal", ["reddit-personal"]));
    expect((await store.list()).map((persona) => persona.id)).toEqual(["work", "personal"]);
    await store.upsert(card("work", ["reddit-work", "x-work"]));
    expect(await store.get("work")).toEqual({ id: "work", capabilities: ["reddit-work", "x-work"] });
    expect(await store.list()).toHaveLength(2);
});

test("remove returns true when present, false when absent", async () => {
    const { store } = tempStore();
    await store.upsert(card("work", ["reddit-work"]));
    expect(await store.remove("work")).toBe(true);
    expect(await store.remove("work")).toBe(false);
    expect(await store.list()).toEqual([]);
});

// One hand-edited card must not take the rest of the personas down with it — least of all on the turn path, where
// the answer decides what an unattended wake may act through.
test("an invalid card is skipped and reported; the rest survive", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "personas-")), `${STATE_DIR}`, "personas.json");
    const skipped: string[] = [];
    const store = filePersonasStore(path, (id) => skipped.push(id));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify([{ id: "broken", capabilities: "not-an-array" }, card("work", ["reddit-work"])]));
    expect((await store.list()).map((persona) => persona.id)).toEqual(["work"]);
    expect(skipped).toEqual(["broken"]);
});

// The card is the committed half of a persona and must stay free of anything that would make committing it a
// mistake. A write that round-trips to exactly what went in is the guard: no token is minted on the way through.
test("a written card holds only the owner's own words", async () => {
    const { store, path } = tempStore();
    await store.upsert({ id: "work", capabilities: ["reddit-work"], label: "Work Reddit", workspace: { startIn: "docs" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([
        { id: "work", capabilities: ["reddit-work"], label: "Work Reddit", workspace: { startIn: "docs" } },
    ]);
});
