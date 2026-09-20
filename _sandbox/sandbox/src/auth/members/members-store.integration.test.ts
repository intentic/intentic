import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fileMembersStore } from "../auth.js";

// The members file on disk: what a desk grant writes, and what a malformed desk row reads as.
const storePath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "members-")), "members.json");

describe("fileMembersStore: desks", () => {
    test("a desk grant round-trips its cards; a re-grade away from desk drops them", async () => {
        const store = fileMembersStore(await storePath());
        await store.add("d@x.com", "desk", ["support"]);
        await expect(store.list()).resolves.toEqual([{ email: "d@x.com", role: "desk", desks: ["support"] }]);
        await store.add("d@x.com", "viewer", ["support"]);
        await expect(store.list()).resolves.toEqual([{ email: "d@x.com", role: "viewer" }]);
    });

    // A desk row with nothing to wear is a sign-in that refuses every message; better read as nobody than as a member.
    test("a desk row naming no card is skipped on read, the rest of the roster kept", async () => {
        const path = await storePath();
        await writeFile(path, JSON.stringify({ members: [{ email: "d@x.com", role: "desk", desks: [] }, { email: "v@x.com", role: "viewer" }] }));
        await expect(fileMembersStore(path).list()).resolves.toEqual([{ email: "v@x.com", role: "viewer" }]);
    });
});
