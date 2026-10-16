import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_CHECKS_FILE } from "@intentic/sandbox-contract/schemas/settings";
import { agreedChecks, declarationHistory, declarationOf, earlierDeclarations, fingerprintOf } from "./repo-checks.js";

// A real repository: what an owner agreed to is read back off the commits that changed the declaration, so a check
// added to the file holds that check alone.

const root = mkdtempSync(join(tmpdir(), "repo-checks-history-"));
const repo = join(root, "intentic");
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Built with no global or system git config, so a signing key or a hook on the machine running the suite never decides it.
const HERMETIC = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: repo, stdio: "ignore", env: HERMETIC });
};

const edit = { when: "edit" as const, run: "node _tools/checks/run.mjs --paths {file}" };
const turn = { when: "turn" as const, run: "node _tools/scripts/verify/verify-turn.mjs" };
const warm = { when: "turn" as const, run: "node _tools/turbo-cache/warm.mjs" };

const declare = (text: string, message: string): void => {
    writeFileSync(join(repo, REPO_CHECKS_FILE), text);
    git("add", "-A");
    git("commit", "-q", "-m", message);
};

beforeAll(() => {
    mkdirSync(join(repo, REPO_CHECKS_FILE, ".."), { recursive: true });
    git("init", "-q");
    declare(JSON.stringify({ checks: [edit] }), "only an edit check");
    declare("{ not json", "caught mid-edit");
    declare(JSON.stringify({ checks: [edit, turn] }), "and a turn check");
    declare(JSON.stringify({ checks: [edit, turn, warm] }), "and a second turn check");
});

test(`every committed version that parses, newest first`, async () => {
    expect(await declarationHistory(root, "intentic")).toEqual([[edit, turn, warm], [edit, turn], [edit]]);
});

test(`a repository git cannot read has no history, which holds what changed`, async () => {
    expect(await declarationHistory(root, "nowhere")).toEqual([]);
});

test(`an answer to an older version runs what it agreed to and holds what came after`, async () => {
    const now = declarationOf("intentic", [edit, turn, warm]);
    const adopted = { intentic: fingerprintOf([edit, turn]) };
    const earlier = await earlierDeclarations(root, [now], adopted, Date.now());
    expect(earlier).toEqual({ intentic: [[edit, turn]] });
    expect(agreedChecks(adopted, now, earlier["intentic"])).toEqual([true, true, false]);
});
