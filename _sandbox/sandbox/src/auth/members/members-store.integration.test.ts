import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestUnreadableError } from "../../store/json-file.js";
import { fileMembersStore } from "../auth.js";

// The members file on disk: what a grant writes, and what a row the daemon would refuse reads as. The file is
// hand-editable and tracked, so both tiers that carry a companion list are pinned here as well as at the route.
const storePath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "members-")), "members.json");

describe("fileMembersStore: email sign-in", () => {
    test("an opt-in round-trips, survives a re-grade that does not mention it, and goes when the owner takes it back", async () => {
        const path = await storePath();
        const store = fileMembersStore(path);
        await store.add("bo@example.org", { tier: "viewer", emailSignIn: true });
        await expect(store.list()).resolves.toEqual([{ email: "bo@example.org", tier: "viewer", emailSignIn: true }]);
        await store.add("bo@example.org", { tier: "collaborator" });
        await expect(store.list()).resolves.toEqual([{ email: "bo@example.org", tier: "collaborator", emailSignIn: true }]);
        await store.add("bo@example.org", { tier: "collaborator", emailSignIn: false });
        await expect(store.list()).resolves.toEqual([{ email: "bo@example.org", tier: "collaborator" }]);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ members: [{ email: "bo@example.org", tier: "collaborator" }] });
    });
});

describe("fileMembersStore: guests", () => {
    test("a guest grant round-trips its fence, and a re-grade keeps it, since areas ride on every tier", async () => {
        const store = fileMembersStore(await storePath());
        await store.add("d@x.com", { tier: "guest", areas: ["support"] });
        await expect(store.list()).resolves.toEqual([{ email: "d@x.com", tier: "guest", areas: ["support"] }]);
        await store.add("d@x.com", { tier: "viewer", areas: ["support"] });
        await expect(store.list()).resolves.toEqual([{ email: "d@x.com", tier: "viewer", areas: ["support"] }]);
    });

    // An unfenced guest would reach every assistant in the workspace, since that absent list is what the whole of it
    // resolves to. Skipped, that person has no access at all, which is the safe direction.
    test("a guest row naming no area is skipped on read, the rest of the roster kept", async () => {
        const path = await storePath();
        await writeFile(
            path,
            JSON.stringify({
                members: [
                    { email: "d@x.com", tier: "guest" },
                    { email: "e@x.com", tier: "guest", areas: [] },
                    { email: "v@x.com", tier: "viewer" },
                ],
            }),
        );
        await expect(fileMembersStore(path).list()).resolves.toEqual([{ email: "v@x.com", tier: "viewer" }]);
    });
});

describe("fileMembersStore: writers", () => {
    test("a writer grant round-trips the areas it may change", async () => {
        const store = fileMembersStore(await storePath());
        await store.add("w@x.com", { tier: "writer", areas: ["support"] });
        await expect(store.list()).resolves.toEqual([{ email: "w@x.com", tier: "writer", areas: ["support"] }]);
    });

    // The one row that must never be read leniently: an absent area list is the WHOLE workspace, so a writer row
    // without one would resolve to a grant to change every file in it. Skipped, that person has no access at all.
    test("a writer row naming no area is skipped on read rather than read as the whole workspace", async () => {
        const path = await storePath();
        await writeFile(
            path,
            JSON.stringify({
                members: [
                    { email: "w@x.com", tier: "writer" },
                    { email: "e@x.com", tier: "writer", areas: [] },
                    { email: "v@x.com", tier: "viewer" },
                ],
            }),
        );
        await expect(fileMembersStore(path).list()).resolves.toEqual([{ email: "v@x.com", tier: "viewer" }]);
    });
});

// Setting an unreadable roster aside and writing a fresh one would keep the one person just granted and drop everybody
// else for good. Refused instead: the file stays as it was for a person to fix, and nobody is granted or removed.
test("a roster this build cannot read refuses a grant and a removal, and stays as it was", async () => {
    const path = await storePath();
    await writeFile(path, `{"members": [{"email": "ada@example.com", "tier": "viewer"}`, "utf8");
    const store = fileMembersStore(path);
    await expect(store.add("grace@example.com", { tier: "viewer" })).rejects.toBeInstanceOf(ManifestUnreadableError);
    await expect(store.remove("ada@example.com")).rejects.toBeInstanceOf(ManifestUnreadableError);
    expect(await readFile(path, "utf8")).toBe(`{"members": [{"email": "ada@example.com", "tier": "viewer"}`);
    expect(existsSync(`${path}.corrupt`)).toBe(false);
});
