import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { PostApprovalSummary } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fileApprovalsStore } from "./approvals-store.js";

// A store over a fresh temp path (the directory doesn't exist yet: the store must create it on write).
const tempStore = () => {
    const dir = join(mkdtempSync(join(tmpdir(), "approvals-")), `${STATE_DIR}`, "config", "approvals");
    return { store: fileApprovalsStore(dir), dir };
};

const post = (id: string, scheduledAt = 1_000): PostApprovalSummary => ({
    id,
    kind: "post",
    platform: "x",
    content: "hello world",
    scheduledAt,
    status: "proposed",
    createdAt: 1,
});

test("upsert writes one file per item (id = filename, never in the body); list sorts by scheduledAt", async () => {
    const { store, dir } = tempStore();
    expect(await store.list()).toEqual({ approvals: [], invalid: [] });
    await store.upsert(post("later", 2_000));
    await store.upsert(post("sooner", 1_000));
    const { approvals } = await store.list();
    expect(approvals.map((item) => item.id)).toEqual(["sooner", "later"]);
    expect(JSON.parse(await readFile(join(dir, "sooner.json"), "utf8"))).not.toHaveProperty("id");
    // Re-upserting the same id edits it in place (approve = re-post with status flipped).
    await store.upsert({ ...post("sooner"), status: "approved" });
    expect((await store.list()).approvals.map((item) => item.status)).toEqual(["approved", "proposed"]);
});

test("agent-written files that fail to parse land in invalid instead of vanishing", async () => {
    const { store, dir } = tempStore();
    await store.upsert(post("good"));
    await writeFile(join(dir, "broken.json"), "{ not json");
    await writeFile(join(dir, "wrong-shape.json"), JSON.stringify({ kind: "post", platform: "x" }));
    await writeFile(join(dir, "bad.name!.json"), JSON.stringify(post("x")));
    // A kind this daemon does not know is a file it cannot act on, and saying so is the whole point of `invalid`.
    await writeFile(join(dir, "unknown-kind.json"), JSON.stringify({ kind: "booking", summary: "hotel" }));
    // The old shape, with no kind at all: not read, not guessed at.
    await writeFile(join(dir, "kindless.json"), JSON.stringify({ platform: "x", content: "hi" }));
    const { approvals, invalid } = await store.list();
    expect(approvals.map((item) => item.id)).toEqual(["good"]);
    expect(invalid.toSorted()).toEqual(["bad.name!.json", "broken.json", "kindless.json", "unknown-kind.json", "wrong-shape.json"]);
});

test("a post with only kind+platform+content parses as proposed (not invalid) and sorts after dated ones", async () => {
    const { store, dir } = tempStore();
    await store.upsert(post("dated", 5_000));
    // The minimum the skill asks for: no scheduledAt, no status, no createdAt.
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dateless.json"), JSON.stringify({ kind: "post", platform: "reddit", content: "hi", title: "t", target: "r/x" }));
    const { approvals, invalid } = await store.list();
    expect(invalid).toEqual([]);
    expect(approvals.map((item) => item.id)).toEqual(["dated", "dateless"]); // undated sorts last, not NaN-shuffled
    const dateless = approvals.find((item) => item.id === "dateless");
    expect(dateless?.status).toBe("proposed");
    expect(dateless?.scheduledAt).toBeUndefined();
});

test("an action with summary+instructions parses beside the posts, as the same queue", async () => {
    const { store, dir } = tempStore();
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, "hotel.json"),
        JSON.stringify({
            kind: "action",
            summary: "Book the Adlon, 12–14 March",
            instructions: "Open booking.com as travel and book it.",
            actsAs: "travel",
        }),
    );
    const { approvals, invalid } = await store.list();
    expect(invalid).toEqual([]);
    expect(approvals[0]).toMatchObject({ id: "hotel", kind: "action", status: "proposed", actsAs: "travel" });
});

test("remove unlinks the file; a second remove reports missing", async () => {
    const { store } = tempStore();
    await store.upsert(post("gone"));
    expect(await store.remove("gone")).toBe(true);
    expect(await store.remove("gone")).toBe(false);
    expect(await store.list()).toEqual({ approvals: [], invalid: [] });
});
