import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_CHECKS_FILE } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { declaredRepoChecks, readRepoDeclaration } from "./repo-checks.js";

// Reading the file a repository actually carries: what a real workspace hands the daemon, including the two ways a
// repository can hand it nothing.

const setup = (): string => mkdtempSync(join(tmpdir(), "repo-checks-"));

const declare = (root: string, repo: string, body: string): void => {
    const file = repo === "root" ? join(root, REPO_CHECKS_FILE) : join(root, repo, REPO_CHECKS_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
};

test("a repository with no declaration is not a row at all", async () => {
    const root = setup();
    mkdirSync(join(root, "intentic", ".git"), { recursive: true });
    expect(await readRepoDeclaration(root, "intentic")).toBeUndefined();
    expect(await declaredRepoChecks(root)).toEqual([]);
});

test("a declaration is read from inside the repository, and the workspace's own from the root", async () => {
    const root = setup();
    mkdirSync(join(root, "intentic", ".git"), { recursive: true });
    declare(root, "intentic", JSON.stringify({ checks: [{ when: "push", run: "pnpm verify:push" }] }));
    declare(root, "root", JSON.stringify({ checks: [{ when: "turn", run: "pnpm lint" }] }));
    const found = await declaredRepoChecks(root);
    // "root" leads: the workspace's own repository is the one most sandboxes work in.
    expect(found.map((declaration) => declaration.repo)).toEqual(["root", "intentic"]);
    expect(found[1]?.checks).toEqual([{ when: "push", run: "pnpm verify:push" }]);
});

test("a file that does not parse reports why and declares nothing, rather than half of something", async () => {
    const root = setup();
    mkdirSync(join(root, "intentic", ".git"), { recursive: true });
    declare(root, "intentic", `{ "checks": [ { "when": "whenever", "run": "pnpm test" } ] }`);
    const declaration = await readRepoDeclaration(root, "intentic");
    expect(declaration?.checks).toEqual([]);
    expect(declaration?.error).toEqual(expect.any(String));
});

test("a declaration that is not even JSON is the same answer, not a crash", async () => {
    const root = setup();
    declare(root, "root", "checks: [pnpm test]");
    const declaration = await readRepoDeclaration(root, "root");
    expect(declaration?.checks).toEqual([]);
    expect(declaration?.error).toEqual(expect.any(String));
});
