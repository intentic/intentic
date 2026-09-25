import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { rename } from "./evolution/conversions.js";
import { defineDocument } from "./evolution/documents.js";
import { idListFile } from "./id-list-file.js";

const dirs: string[] = [];
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const listAt = async (content: unknown): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-id-list-"));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "list.json");
    await writeFile(path, JSON.stringify(content));
    return path;
};

const Card = z.object({ id: z.string(), name: z.string() });

test("an upsert keeps the replaced entry's keys this build does not know, and leaves unreadable entries alone", async () => {
    const path = await listAt([
        { id: "a", name: "Ada", accounts: ["gh"] },
        { id: "b", name: 7 },
    ]);
    const store = idListFile(path, Card);
    expect(await store.list()).toEqual([{ id: "a", name: "Ada" }]);
    await store.upsert({ id: "a", name: "Ada L." });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([
        { id: "b", name: 7 },
        { id: "a", name: "Ada L.", accounts: ["gh"] },
    ]);
});

test("the document's conversions run per entry before validation", async () => {
    const path = await listAt([{ id: "a", title: "Ada" }]);
    const document = defineDocument({ path: "evolution/cards.json", schema: Card, granularity: "entries", history: [rename("title", "name")] });
    expect(await idListFile(path, Card, undefined, document).list()).toEqual([{ id: "a", name: "Ada" }]);
});
