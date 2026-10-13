import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileMemberAiLiteracy } from "./member-ai-literacy.js";

test("confirmations persist per member and version and repeated confirmation keeps its first time", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ai-literacy-")), "member-ai-literacy.json");
    const store = fileMemberAiLiteracy(path);
    expect(await store.list()).toEqual([]);
    const first = await store.confirm("member@example.org", "a".repeat(64));
    expect(await store.confirm("member@example.org", "a".repeat(64))).toBe(first);
    expect(await store.confirmedAt("member@example.org", "b".repeat(64))).toBeUndefined();
    const changed = await store.confirm("member@example.org", "b".repeat(64));
    expect((await fileMemberAiLiteracy(path).list())).toEqual([
        { member: "member@example.org", version: "a".repeat(64), confirmedAt: first },
        { member: "member@example.org", version: "b".repeat(64), confirmedAt: changed },
    ]);
});
