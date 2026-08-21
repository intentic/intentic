import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { expect, test } from "vitest";
import { discoverRepos, isValidRepoId, isValidRepoName } from "./repo-discovery.js";

const setup = (): string => mkdtempSync(join(tmpdir(), "repo-discovery-"));

test("a repo is any dir owning a .git (dir or pointer file) at any depth, sorted by id", async () => {
    const root = setup();
    mkdirSync(join(root, "intent", ".git"), { recursive: true });
    // A daemon-created repo keeps a .git pointer FILE (--separate-git-dir): it must count too.
    mkdirSync(join(root, "shop"), { recursive: true });
    writeFileSync(join(root, "shop", ".git"), "gitdir: /history/gits/shop\n");
    mkdirSync(join(root, "clients", "foo", ".git"), { recursive: true });
    expect(await discoverRepos(root)).toEqual(["clients/foo", "intent", "shop"]);
});

test("the walk stops at the first .git boundary, a nested repo belongs to its parent", async () => {
    const root = setup();
    mkdirSync(join(root, "app", ".git"), { recursive: true });
    mkdirSync(join(root, "app", "vendor", "lib", ".git"), { recursive: true });
    expect(await discoverRepos(root)).toEqual(["app"]);
});

test("hidden dirs, junk dirs, symlinks, the reserved 'root' name, and the reference shelf are never repos", async () => {
    const root = setup();
    mkdirSync(join(root, `${STATE_DIR}`, "local", "cache", ".git"), { recursive: true });
    mkdirSync(join(root, "node_modules", "dep", ".git"), { recursive: true });
    mkdirSync(join(root, "root", ".git"), { recursive: true });
    // The reference shelf: a clone dropped there is consulted by path, never a workspace repo.
    mkdirSync(join(root, "refs", "react", ".git"), { recursive: true });
    mkdirSync(join(root, "real", ".git"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "linked"));
    // The workspace root's own .git (the shadow root repo) is not a workspace repo.
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(await discoverRepos(root)).toEqual(["real"]);
});

test("repos deeper than the depth cap are not discovered", async () => {
    const root = setup();
    mkdirSync(join(root, "a", "b", "c", "d", ".git"), { recursive: true }); // depth 4 — discovered
    mkdirSync(join(root, "a", "b", "c", "e", "f", ".git"), { recursive: true }); // depth 5 — beyond the cap
    expect(await discoverRepos(root)).toEqual(["a/b/c/d"]);
});

test("isValidRepoName accepts a single safe segment and rejects reserved names", () => {
    expect(isValidRepoName("shop")).toBe(true);
    expect(isValidRepoName("my.repo_2")).toBe(true);
    for (const reserved of ["intent", "desired-state", "app", "root", "refs"]) {
        expect(isValidRepoName(reserved)).toBe(false);
    }
    expect(isValidRepoName("../evil")).toBe(false);
    expect(isValidRepoName(".hidden")).toBe(false);
});

test("isValidRepoId accepts nested ids (roles included) but never 'root', the reference shelf, or an escape", () => {
    expect(isValidRepoId("intent")).toBe(true);
    expect(isValidRepoId("clients/foo")).toBe(true);
    expect(isValidRepoId("root")).toBe(false);
    // Discovery never returns a shelf repo, so no wire id may name one; a repo's own refs subdir still can be
    // part of a valid nested id only when it isn't the FIRST segment.
    expect(isValidRepoId("refs")).toBe(false);
    expect(isValidRepoId("refs/react")).toBe(false);
    expect(isValidRepoId("clients/refs")).toBe(true);
    expect(isValidRepoId("a/../b")).toBe(false);
    expect(isValidRepoId("/abs")).toBe(false);
    expect(isValidRepoId("a/b/c/d/e")).toBe(false); // beyond the depth cap
});
