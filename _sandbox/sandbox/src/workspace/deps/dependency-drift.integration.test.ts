import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { modulesNear, unresolvedDependencies, unresolvedSummary } from "./dependency-drift.js";

const project = async (): Promise<string> => mkdtemp(join(tmpdir(), "drift-"));

const write = async (root: string, path: string, content = "{}"): Promise<void> => {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
};

// An installed package is a directory with a manifest, which is what both node_modules layouts produce (pnpm
// symlinks one in, npm copies one).
const installed = (root: string, dir: string, name: string): Promise<void> => write(root, join(dir, "node_modules", name, "package.json"));

const workspaceFile = (root: string, globs: readonly string[]): Promise<void> =>
    write(root, "pnpm-workspace.yaml", `packages:\n${globs.map((glob) => `  - "${glob}"\n`).join("")}`);

test("a single-package project with everything installed reports no drift", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"app","dependencies":{"left-pad":"^1.3.0"}}`);
    await installed(root, "", "left-pad");
    expect(await unresolvedDependencies(root)).toEqual([]);
});

test("a dependency added to the manifest and never installed is the drift this exists for", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"app","dependencies":{"left-pad":"^1.3.0","right-pad":"^1.0.0"}}`);
    await installed(root, "", "left-pad");
    expect(await unresolvedDependencies(root)).toEqual([{ dir: "", names: ["right-pad"] }]);
});

test("devDependencies count: a missing test runner breaks the suite as surely as a missing import", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"app","devDependencies":{"vitest":"^4.0.0"}}`);
    expect(await unresolvedDependencies(root)).toEqual([{ dir: "", names: ["vitest"] }]);
});

test("optional and peer dependencies are never drift: absent is what optional means, and a peer is the consumer's", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"app","optionalDependencies":{"fsevents":"*"},"peerDependencies":{"vue":"^3"}}`);
    expect(await unresolvedDependencies(root)).toEqual([]);
});

test("workspace members are checked against their OWN node_modules, which is where pnpm puts a direct dependency", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"root"}`);
    await workspaceFile(root, ["packages/*"]);
    await write(root, "packages/web/package.json", `{"name":"web","dependencies":{"vue":"^3"}}`);
    await write(root, "packages/api/package.json", `{"name":"api","dependencies":{"hono":"^4"}}`);
    await installed(root, "packages/web", "vue");
    expect(await unresolvedDependencies(root)).toEqual([{ dir: "packages/api", names: ["hono"] }]);
});

test("a hoisted tree satisfies a member too: npm and yarn put almost everything at the install root", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"root"}`);
    await workspaceFile(root, ["packages/*"]);
    await write(root, "packages/web/package.json", `{"name":"web","dependencies":{"vue":"^3"}}`);
    await installed(root, "", "vue");
    expect(await unresolvedDependencies(root)).toEqual([]);
});

/* The case a lockfile comparison gets wrong, and the reason this module reads the tree instead. A package that
 * IS an importer in the lockfile, so manifest and lockfile agree perfectly: can still have no installed tree
 * at all, which is exactly the state two packages of this workspace were found in. */
test("a member with no node_modules at all is drift, however well its manifest agrees with the lockfile", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"root"}`);
    await workspaceFile(root, ["packages/*"]);
    await write(root, "packages/fresh/package.json", `{"name":"fresh","dependencies":{"vue":"^3","zod":"^4"}}`);
    expect(await unresolvedDependencies(root)).toEqual([{ dir: "packages/fresh", names: ["vue", "zod"] }]);
});

test("resolution never walks intermediate directories: an ancestor's tree is not this project's install", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"root"}`);
    await workspaceFile(root, ["packages/*"]);
    await write(root, "packages/group/package.json", `{"name":"group"}`);
    await write(root, "packages/group/web/package.json", `{"name":"web"}`);
    // A tree at an intermediate level that neither the member nor the install root owns.
    await installed(root, "packages/group", "vue");
    await write(root, "packages/web/package.json", `{"name":"member","dependencies":{"vue":"^3"}}`);
    expect(await unresolvedDependencies(root)).toEqual([{ dir: "packages/web", names: ["vue"] }]);
});

test("an unreadable or malformed manifest contributes nothing rather than throwing", async () => {
    const root = await project();
    await write(root, "package.json", "not json");
    expect(await unresolvedDependencies(root)).toEqual([]);
});

test("modulesNear separates a tree that was never installed from one that is merely behind", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"app","dependencies":{"vue":"^3"}}`);
    await write(root, "src/main.ts", "");
    expect(await modulesNear(join(root, "src/main.ts"))).toEqual({ kind: "absent" });
    await installed(root, "", "vue");
    expect(await modulesNear(join(root, "src/main.ts"))).toEqual({ kind: "installed", missing: [] });
});

// The shape an isolated turn presents to the daemon: the overlay is mounted inside the turn's namespace, so
// from outside every node_modules on the path is present and empty. Read as an install root it made a fully
// installed package look like one missing every dependency it declares.
test("an EMPTY node_modules is a mount point, not an install: the walk goes past it", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"app","dependencies":{"vue":"^3"}}`);
    await write(root, "src/main.ts", "");
    await mkdir(join(root, "node_modules"), { recursive: true });
    expect(await modulesNear(join(root, "src/main.ts"))).toEqual({ kind: "absent" });
    await installed(root, "", "vue");
    expect(await modulesNear(join(root, "src/main.ts"))).toEqual({ kind: "installed", missing: [] });
});

test("modulesNear answers for the package that OWNS the file, not the install root above it", async () => {
    const root = await project();
    await write(root, "package.json", `{"name":"root","dependencies":{"turbo":"^2"}}`);
    await installed(root, "", "turbo");
    await write(root, "packages/web/package.json", `{"name":"web","dependencies":{"vue":"^3"}}`);
    await write(root, "packages/web/src/main.ts", "");
    // The root's own tree satisfies the root, and says nothing about what `web` declares.
    expect(await modulesNear(join(root, "packages/web/src/main.ts"))).toEqual({ kind: "installed", missing: ["vue"] });
    await installed(root, "packages/web", "vue");
    expect(await modulesNear(join(root, "packages/web/src/main.ts"))).toEqual({ kind: "installed", missing: [] });
});

test("the summary names a few and counts the rest: the decision is made by the third name", async () => {
    expect(unresolvedSummary([{ dir: "", names: ["a", "b"] }])).toBe("a, b");
    expect(
        unresolvedSummary([
            { dir: "", names: ["a", "b", "c"] },
            { dir: "x", names: ["d", "e", "f"] },
        ]),
    ).toBe("a, b, c, d and 2 more");
    // One shared workspace library missing from six packages is six entries and ONE thing to say: without this
    // the sample spends its slots repeating a name the reader already read.
    expect(
        unresolvedSummary([
            { dir: "a", names: ["shared"] },
            { dir: "b", names: ["shared"] },
            { dir: "c", names: ["shared", "vue"] },
        ]),
    ).toBe("shared, vue");
});
