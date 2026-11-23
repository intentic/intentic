import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ARTIFACTS_DIR, artifactDigest, artifactPart, keepArtifactCopy, readArtifact, sha256Of } from "./stored-artifacts.js";

/* An artifact travels between machines only from and into the artifacts folder: a runner's picture is filed here by the
   path its card names (runners/held-turns/runner-pictures.ts), and a runner serves one by that path. */

let root: string;
let outside: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "stored-artifacts-"));
    outside = await mkdtemp(join(tmpdir(), "stored-artifacts-outside-"));
    await mkdir(join(root, ARTIFACTS_DIR, "browser"), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
});

test("a path outside the artifacts folder is neither served nor filed, whichever way it climbs out", async () => {
    await writeFile(join(root, "secret.txt"), "not a picture");
    await writeFile(join(outside, "elsewhere.png"), "not ours");
    await symlink(outside, join(root, ARTIFACTS_DIR, "linked"));
    expect(await readArtifact(root, "secret.txt")).toEqual({ kind: "none" });
    expect(await readArtifact(root, `${ARTIFACTS_DIR}../../../secret.txt`)).toEqual({ kind: "none" });
    expect(await readArtifact(root, `${ARTIFACTS_DIR}linked/elsewhere.png`)).toEqual({ kind: "none" });
    expect(await keepArtifactCopy(root, "src/shot.png", Buffer.from("x"))).toBeUndefined();
    expect(await keepArtifactCopy(root, `${ARTIFACTS_DIR}linked/planted.png`, Buffer.from("x"))).toBeUndefined();
    await expect(readFile(join(outside, "planted.png"))).rejects.toThrow();
});

test("a copy takes its own name when free, keeps one already holding its bytes, and numbers past one holding others", async () => {
    const shot = `${ARTIFACTS_DIR}browser/after.png`;
    expect(await keepArtifactCopy(root, shot, Buffer.from("first"))).toBe(shot);
    expect(await keepArtifactCopy(root, shot, Buffer.from("first"))).toBe(shot);
    expect(await keepArtifactCopy(root, shot, Buffer.from("second"))).toBe(`${ARTIFACTS_DIR}browser/after-2.png`);
    expect(await keepArtifactCopy(root, shot, Buffer.from("second"))).toBe(`${ARTIFACTS_DIR}browser/after-2.png`);
    expect(await readFile(join(root, shot), "utf8")).toBe("first");
    expect(await artifactDigest(root, `${ARTIFACTS_DIR}browser/after-2.png`)).toBe(sha256Of(Buffer.from("second")));
    // A folder the runner's agent made inside the artifacts folder is made here too.
    expect(await keepArtifactCopy(root, `${ARTIFACTS_DIR}probe/run-1/frame.png`, Buffer.from("f"))).toBe(`${ARTIFACTS_DIR}probe/run-1/frame.png`);
});

// A file brought in pieces (runners/held-turns/runner-artifacts.ts) is written beside where it goes and filed by the same
// rule as a copy in one piece, never replacing a file, and leaves no part behind either way.
test("a file brought in pieces is filed by the copy's rule and leaves no part behind", async () => {
    const take = `${ARTIFACTS_DIR}renders/take.mp4`;
    const bring = async (text: string, discard = false): Promise<string | undefined> => {
        const part = await artifactPart(root, take);
        if (part === undefined) {
            throw new Error("no part for a path in the artifacts folder");
        }
        await writeFile(part.real, text);
        if (discard) {
            await part.discard();
            return undefined;
        }
        return part.keep();
    };
    expect(await bring("first")).toBe(take);
    expect(await bring("first")).toBe(take);
    expect(await bring("second")).toBe(`${ARTIFACTS_DIR}renders/take-2.mp4`);
    expect(await bring("third", true)).toBeUndefined();
    expect(await readFile(join(root, take), "utf8")).toBe("first");
    expect((await readdir(join(root, ARTIFACTS_DIR, "renders"))).toSorted()).toEqual(["take-2.mp4", "take.mp4"]);
    expect(await artifactPart(root, "src/take.mp4")).toBeUndefined();
});

// Review, 2026-11-23: the folder a copy is filed in was made before its path was checked, so `artifacts/../../../x/y`
// made folders outside the workspace, and a link inside the artifacts folder made them wherever it led.
test("a copy whose path climbs out of the artifacts folder, or through a link out of it, makes no folder anywhere", async () => {
    const away = await mkdtemp(join(tmpdir(), "stored-artifacts-away-"));
    try {
        // Up past the workspace, into its parent folder.
        const made = join(dirname(root), `${basename(away)}-made`);
        const climb = `${ARTIFACTS_DIR}../../../../${basename(made)}/y/x.png`;
        expect(await keepArtifactCopy(root, climb, Buffer.from("x"))).toBeUndefined();
        expect(await artifactPart(root, climb)).toBeUndefined();
        expect(existsSync(made)).toBe(false);
        await mkdir(join(root, ARTIFACTS_DIR), { recursive: true });
        await symlink(away, join(root, ARTIFACTS_DIR, "linked"));
        expect(await keepArtifactCopy(root, `${ARTIFACTS_DIR}linked/deep/x.png`, Buffer.from("x"))).toBeUndefined();
        expect(await artifactPart(root, `${ARTIFACTS_DIR}linked/deeper/x.png`)).toBeUndefined();
        expect(await readdir(away)).toEqual([]);
    } finally {
        await rm(away, { recursive: true, force: true });
    }
});
