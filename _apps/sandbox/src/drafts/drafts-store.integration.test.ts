import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftSummary } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fileDraftsStore } from "./drafts-store.js";

// A store over a fresh temp path (the drafts dir doesn't exist yet — the store must create it on write).
const tempStore = () => {
    const dir = join(mkdtempSync(join(tmpdir(), "drafts-")), ".intentic", "drafts");
    return { store: fileDraftsStore(dir), dir };
};

const draft = (id: string, scheduledAt = 1_000): DraftSummary => ({
    id,
    platform: "x",
    content: "hello world",
    scheduledAt,
    status: "proposed",
    createdAt: 1,
});

test("upsert writes one file per draft (id = filename, never in the body); list sorts by scheduledAt", async () => {
    const { store, dir } = tempStore();
    expect(await store.list()).toEqual({ drafts: [], invalid: [] });
    await store.upsert(draft("later", 2_000));
    await store.upsert(draft("sooner", 1_000));
    const { drafts } = await store.list();
    expect(drafts.map((d) => d.id)).toEqual(["sooner", "later"]);
    expect(JSON.parse(await readFile(join(dir, "sooner.json"), "utf8"))).not.toHaveProperty("id");
    // Re-upserting the same id edits it in place (approve = re-post with status flipped).
    await store.upsert({ ...draft("sooner"), status: "approved" });
    expect((await store.list()).drafts.map((d) => d.status)).toEqual(["approved", "proposed"]);
});

test("agent-written files that fail to parse land in invalid instead of vanishing", async () => {
    const { store, dir } = tempStore();
    await store.upsert(draft("good"));
    await writeFile(join(dir, "broken.json"), "{ not json");
    await writeFile(join(dir, "wrong-shape.json"), JSON.stringify({ platform: "x" }));
    await writeFile(join(dir, "bad.name!.json"), JSON.stringify(draft("x")));
    const { drafts, invalid } = await store.list();
    expect(drafts.map((d) => d.id)).toEqual(["good"]);
    expect(invalid.toSorted()).toEqual(["bad.name!.json", "broken.json", "wrong-shape.json"]);
});

test("an agent draft with only platform+content parses as proposed (not invalid) and sorts after dated ones", async () => {
    const { store, dir } = tempStore();
    await store.upsert(draft("dated", 5_000));
    // The exact shape the UI was rejecting: no scheduledAt, no status, no createdAt.
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dateless.json"), JSON.stringify({ platform: "reddit", content: "hi", title: "t", target: "r/x" }));
    const { drafts, invalid } = await store.list();
    expect(invalid).toEqual([]);
    expect(drafts.map((d) => d.id)).toEqual(["dated", "dateless"]); // undated sorts last, not NaN-shuffled
    const dateless = drafts.find((d) => d.id === "dateless");
    expect(dateless?.status).toBe("proposed");
    expect(dateless?.scheduledAt).toBeUndefined();
});

test("remove unlinks the file; a second remove reports missing", async () => {
    const { store } = tempStore();
    await store.upsert(draft("gone"));
    expect(await store.remove("gone")).toBe(true);
    expect(await store.remove("gone")).toBe(false);
    expect(await store.list()).toEqual({ drafts: [], invalid: [] });
});
