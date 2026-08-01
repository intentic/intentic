import { mkdtempSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileActivityStore } from "./activity-store.js";

const storePath = (): string => join(mkdtempSync(join(tmpdir(), "activity-")), "activity.jsonl");

test("append fills id and at; list returns newest first with provider, before, and limit applied", async () => {
    const path = storePath();
    const store = fileActivityStore(path);
    await store.append({ provider: "discord", direction: "in", type: "message.received", content: "first" });
    await store.append({ provider: "discord", direction: "out", type: "message.send", content: "second" });
    await store.append({ direction: "system", type: "automation.run" });

    const all = await store.list({ limit: 10 });
    expect(all).toHaveLength(3);
    expect(all.map(({ type }) => type)).toEqual(["automation.run", "message.send", "message.received"]);
    expect(all[0]?.id).not.toBe("");
    expect(all[0]?.at).toBeGreaterThan(0);

    const discordOnly = await store.list({ provider: "discord", limit: 10 });
    expect(discordOnly.map(({ type }) => type)).toEqual(["message.send", "message.received"]);

    const paged = await store.list({ limit: 10, before: all[1]?.at });
    expect(paged.map(({ type }) => type)).toEqual(["message.received"]);

    expect(await store.list({ limit: 1 })).toHaveLength(1);
});

test("a corrupt line is skipped, never the log", async () => {
    const path = storePath();
    const store = fileActivityStore(path);
    await store.append({ provider: "discord", direction: "in", type: "message.received" });
    await appendFile(path, "{torn line\n");
    await store.append({ provider: "discord", direction: "out", type: "message.send" });
    expect((await store.list({ limit: 10 })).map(({ type }) => type)).toEqual(["message.send", "message.received"]);
});

test("passing the byte cap prunes to the newest lines", async () => {
    const path = storePath();
    // Pre-seed past 5MB directly (sequential appends would prune on every write past the cap).
    const filler = "x".repeat(2_500);
    const lines = Array.from({ length: 2_100 }, (_, i) =>
        JSON.stringify({ id: `seed-${i}`, at: i + 1, provider: "discord", direction: "in", type: "message.received", content: filler }),
    );
    await writeFile(path, `${lines.join("\n")}\n`);

    const store = fileActivityStore(path);
    await store.append({ provider: "discord", direction: "out", type: "message.send" });

    const kept = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
    expect(kept).toHaveLength(2_000);
    // Newest survive: the fresh append plus the tail of the seeds; the oldest seeds are gone.
    expect(kept.at(-1)).toContain("message.send");
    expect(kept[0]).toContain("seed-101");
});
