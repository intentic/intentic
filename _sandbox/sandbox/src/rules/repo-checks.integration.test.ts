import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_CHECKS_FILE, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { declaredRepoChecks, readRepoDeclaration, repoCheckRules } from "./repo-checks.js";

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
    declare(root, "intentic", JSON.stringify({ checks: [{ when: "turn", run: "pnpm verify:turn" }] }));
    declare(root, "root", JSON.stringify({ checks: [{ when: "turn", run: "pnpm lint" }] }));
    const found = await declaredRepoChecks(root);
    // "root" leads: the workspace's own repository is the one most sandboxes work in.
    expect(found.map((declaration) => declaration.repo)).toEqual(["root", "intentic"]);
    expect(found[1]?.checks).toEqual([{ when: "turn", run: "pnpm verify:turn" }]);
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

test("a declaration that exists but cannot be read is that repository's error row, and the others still read", async () => {
    const root = setup();
    mkdirSync(join(root, "intentic", ".git"), { recursive: true });
    // A directory where the file belongs: readFile fails with EISDIR, which is neither "declares nothing" nor JSON.
    mkdirSync(join(root, "intentic", REPO_CHECKS_FILE), { recursive: true });
    declare(root, "root", JSON.stringify({ checks: [{ when: "turn", run: "pnpm lint" }] }));
    const found = await declaredRepoChecks(root);
    expect(found.map(({ repo, checks, error }) => ({ repo, checks: checks.length, error }))).toEqual([
        { repo: "root", checks: 1, error: undefined },
        { repo: "intentic", checks: 0, error: "the file could not be read (EISDIR)" },
    ]);
});

// `turn` was the check a conversation ran before it finished. Nothing runs inside a conversation now, so a repository
// that still declares one keeps reading as written, keeps its adoption, and runs only the checks that still have a moment.
test("a declaration still naming the retired turn moment reads as written, and once adopted stands as its edit check alone", async () => {
    const root = setup();
    mkdirSync(join(root, "intentic", ".git"), { recursive: true });
    const checks = [
        { when: "edit", run: "pnpm lint {file}" },
        { when: "turn", run: "pnpm verify:turn" },
        { when: "land", run: "pnpm verify" },
    ] as const;
    declare(root, "intentic", JSON.stringify({ checks }));
    const declaration = await readRepoDeclaration(root, "intentic");
    expect(declaration?.checks).toEqual(checks);

    const rules = await repoCheckRules({
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ adoptedChecks: { intentic: declaration?.fingerprint } }),
        }),
        logger: unstubbed<Services["logger"]>("logger", {}),
    });
    expect(rules.map(({ moment, when, action }) => ({ moment, when, action }))).toEqual([
        { moment: "file.edited", when: { repo: "intentic" }, action: { kind: "command", command: "pnpm lint {file}", timeoutMs: 900_000 } },
    ]);
});
