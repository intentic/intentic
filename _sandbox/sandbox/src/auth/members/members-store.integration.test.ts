import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "bun:test";
import { fileMembersStore } from "../auth.js";

// The members file on disk: what a grant writes, and what a row the daemon would refuse reads as. The file is
// hand-editable and tracked, so both tiers that carry a companion list are pinned here as well as at the route.
const storePath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "members-")), "members.json");

describe("fileMembersStore: guests", () => {
    test("a guest grant round-trips its fence, and a re-grade keeps it, since areas ride on every tier", async () => {
        const store = fileMembersStore(await storePath());
        await store.add("d@x.com", { role: "guest", areas: ["support"] });
        await expect(store.list()).resolves.toEqual([{ email: "d@x.com", role: "guest", areas: ["support"] }]);
        await store.add("d@x.com", { role: "viewer", areas: ["support"] });
        await expect(store.list()).resolves.toEqual([{ email: "d@x.com", role: "viewer", areas: ["support"] }]);
    });

    // An unfenced guest would reach every assistant in the workspace, since that absent list is what the whole of it
    // resolves to. Skipped, that person has no access at all, which is the safe direction.
    test("a guest row naming no area is skipped on read, the rest of the roster kept", async () => {
        const path = await storePath();
        await writeFile(
            path,
            JSON.stringify({
                members: [
                    { email: "d@x.com", role: "guest" },
                    { email: "e@x.com", role: "guest", areas: [] },
                    { email: "v@x.com", role: "viewer" },
                ],
            }),
        );
        await expect(fileMembersStore(path).list()).resolves.toEqual([{ email: "v@x.com", role: "viewer" }]);
    });
});

describe("fileMembersStore: writers", () => {
    test("a writer grant round-trips the areas it may change", async () => {
        const store = fileMembersStore(await storePath());
        await store.add("w@x.com", { role: "writer", areas: ["support"] });
        await expect(store.list()).resolves.toEqual([{ email: "w@x.com", role: "writer", areas: ["support"] }]);
    });

    // The one row that must never be read leniently: an absent area list is the WHOLE workspace, so a writer row
    // without one would resolve to a grant to change every file in it. Skipped, that person has no access at all.
    test("a writer row naming no area is skipped on read rather than read as the whole workspace", async () => {
        const path = await storePath();
        await writeFile(
            path,
            JSON.stringify({
                members: [
                    { email: "w@x.com", role: "writer" },
                    { email: "e@x.com", role: "writer", areas: [] },
                    { email: "v@x.com", role: "viewer" },
                ],
            }),
        );
        await expect(fileMembersStore(path).list()).resolves.toEqual([{ email: "v@x.com", role: "viewer" }]);
    });
});
