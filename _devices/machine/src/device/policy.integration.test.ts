import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { assertPath, ScopeError } from "./policy.js";

// Roots judged on a real temp tree with real symlinks: an allowed folder, a sibling outside it, and links between.

const base = realpathSync(mkdtempSync(join(tmpdir(), "device-policy-")));
const root = join(base, "allowed");
const outside = join(base, "outside");
mkdirSync(root);
mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "not yours");
writeFileSync(join(root, "notes.txt"), "yours");
symlinkSync(join(outside, "secret.txt"), join(root, "secret-link"));
symlinkSync(outside, join(root, "outside-link"));
symlinkSync(join(root, "notes.txt"), join(root, "notes-link"));
symlinkSync(root, join(base, "allowed-link"));

const grant = (roots: string): DeviceScopes => ({
    shell: "off",
    write: "on",
    screen: "off",
    control: "off",
    sandboxes: "off",
    destructive: "off",
    roots,
});

afterAll(() => {
    rmSync(base, { recursive: true, force: true });
});

test("a link inside an allowed folder that leads out of it is refused, naming where it leads", async () => {
    const refusal = assertPath(join(root, "secret-link"), grant(root), "read");
    await expect(refusal).rejects.toThrow(ScopeError);
    await expect(refusal).rejects.toThrow(`(it leads to ${join(outside, "secret.txt")})`);
});

test("a new file under a folder link that leads out is judged by where it would land", async () => {
    await expect(assertPath(join(root, "outside-link", "new", "file.txt"), grant(root), "write")).rejects.toThrow(ScopeError);
});

test("a link that stays inside answers with the real file, the one to operate on", async () => {
    expect(await assertPath(join(root, "notes-link"), grant(root), "read")).toBe(join(root, "notes.txt"));
});

test("a path that does not exist yet is its nearest existing folder's real path with the rest appended", async () => {
    expect(await assertPath(join(base, "allowed-link", "a", "b.txt"), grant(root), "write")).toBe(join(root, "a", "b.txt"));
});

// macOS's /tmp is a link to /private/tmp: a root named through a link must still hold what is under it.
test("a root named through a link still allows what is under it", async () => {
    expect(await assertPath(join(root, "notes.txt"), grant(join(base, "allowed-link")), "read")).toBe(join(root, "notes.txt"));
});

// A move acts on the link, so where it leads does not matter: the link itself is inside.
test("judging the link itself answers with the link, wherever it leads", async () => {
    expect(await assertPath(join(root, "secret-link"), grant(root), "trash", { link: "itself" })).toBe(join(root, "secret-link"));
    await expect(assertPath(join(base, "allowed-link"), grant(root), "trash", { link: "itself" })).rejects.toThrow(ScopeError);
});
