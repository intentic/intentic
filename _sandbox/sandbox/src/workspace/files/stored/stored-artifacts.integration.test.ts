import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACTS_DIR, artifactDigest, keepArtifactCopy, readArtifact, sha256Of } from "./stored-artifacts.js";

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
