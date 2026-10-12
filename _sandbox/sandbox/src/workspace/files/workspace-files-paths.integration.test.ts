import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { resolveRealWithin, resolveWorkspacePath } from "./workspace-files-paths.js";

// The real-path guard every write and copy out of the workspace goes through, against real directories and real
// symlinks: a lexical check passes all of these, and what lands on disk is the claim.

// A workspace with a vault in its control plane, a folder linked into it, a folder linked out of the workspace, and
// a folder linked to another ordinary folder inside it.
const linkedWorkspace = async (): Promise<{ root: string; outside: string }> => {
    const root = await mkdtemp(join(tmpdir(), "paths-root-"));
    const outside = await mkdtemp(join(tmpdir(), "paths-outside-"));
    await mkdir(join(root, STATE_DIR, "secrets/auth"), { recursive: true });
    await writeFile(join(root, STATE_DIR, "secrets/auth/x.json"), "{}");
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await symlink(join(root, STATE_DIR, "secrets/auth"), join(root, "notes/k"));
    await symlink(outside, join(root, "notes/out"));
    await symlink(join(root, "docs"), join(root, "notes/docs"));
    return { root, outside };
};

test("resolveWorkspacePath refuses a symlinked folder into the control plane, as the control plane", async () => {
    const { root } = await linkedWorkspace();
    expect((await resolveWorkspacePath(root, "notes/k/x.json")).kind).toBe("controlPlane");
    // Also for a file not written yet: it resolves through the linked folder that does exist.
    expect((await resolveWorkspacePath(root, "notes/k/new.json")).kind).toBe("controlPlane");
    expect((await resolveWorkspacePath(root, `${STATE_DIR}/secrets/auth/x.json`)).kind).toBe("controlPlane");
});

test("resolveWorkspacePath refuses a symlinked folder out of the root, and a lexical climb", async () => {
    const { root } = await linkedWorkspace();
    expect((await resolveWorkspacePath(root, "notes/out/new.txt")).kind).toBe("outside");
    expect((await resolveWorkspacePath(root, "../etc/passwd")).kind).toBe("outside");
});

test("resolveWorkspacePath keeps the spelled path and reports where a link inside the root really lands", async () => {
    const { root } = await linkedWorkspace();
    const resolved = await resolveWorkspacePath(root, "notes/docs/a.md");
    expect(resolved).toEqual({
        kind: "inside",
        path: join(root, "notes/docs/a.md"),
        real: join(await realpath(root), "docs/a.md"),
        realRel: "docs/a.md",
    });
});

test("resolveRealWithin asks about the entry itself when told to, so a link is judged where it sits", async () => {
    const { root } = await linkedWorkspace();
    const notes = join(root, "notes");
    // Followed, the link lands outside `notes`; as an entry it is a name inside it, and removing it takes only the link.
    expect(await resolveRealWithin(notes, "out")).toBeUndefined();
    expect((await resolveRealWithin(notes, "out", { entry: true }))?.realRel).toBe("out");
    // A linked folder on the way still carries the entry out, whichever way it is asked.
    expect(await resolveRealWithin(notes, "out/file.txt", { entry: true })).toBeUndefined();
    expect(await resolveRealWithin(notes, "../docs")).toBeUndefined();
});
