import { join } from "node:path";
import { fakeFiles } from "../harness/route-fakes.testing.js";
import { clearManifestProblems, recordedProblems } from "../store/manifest-problems.js";
import { type IdentitySeams, workspaceIdentity, workspaceIdentityDocument } from "./workspace-identity.js";

// The id is minted once, for an absent file; a file this build cannot read keeps its bytes and costs nothing but a
// report, because a new id would tell every browser the workspace had been wiped.

const ROOT = "/work";
const PATH = join(ROOT, workspaceIdentityDocument.path);

const over = (disk: Map<string, string>): IdentitySeams => ({
    workspace: { root: ROOT },
    files: fakeFiles({
        read: async (path) => disk.get(path),
        write: async (path, content) => {
            disk.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
        },
    }),
});

afterEach(() => {
    clearManifestProblems();
});

test("an absent file mints an id once, and every later read returns it", async () => {
    const disk = new Map<string, string>();
    const minted = await workspaceIdentity(over(disk));
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    expect(await workspaceIdentity(over(disk))).toBe(minted);
    expect(JSON.parse(disk.get(PATH) ?? "")).toEqual({ id: minted });
});

test("a file this build cannot read is reported and left as it stands, with one stable stand-in id", async () => {
    const disk = new Map([[PATH, "{ half"]]);
    const first = await workspaceIdentity(over(disk));
    expect(first).toMatch(/^unreadable-[0-9a-f]{16}$/);
    expect(await workspaceIdentity(over(disk))).toBe(first);
    expect(disk.get(PATH)).toBe("{ half");
    expect(recordedProblems(PATH)).toEqual([{ kind: "unreadable", detail: "the file is not valid JSON" }]);

    disk.set(PATH, JSON.stringify({ id: "kept-id" }));
    expect(await workspaceIdentity(over(disk))).toBe("kept-id");
    expect(recordedProblems(PATH)).toEqual([]);
});
