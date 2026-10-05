import { MEMORY_FILE, WORKSPACE_ROOT } from "@intentic/constants";
import { isProjectDirName, RESERVED_PROJECT_DIR_NAMES, STARTER_REPO } from "@intentic/sandbox-contract";
import { REPO_ROLES } from "@intentic/scaffold";
import { IGNORED_DIRS, PUBLIC_DIR, REFERENCE_DIR } from "@intentic/workspace-ignore";
import type { Config } from "../env.config.js";
import { testConfig } from "../testing.js";
import { COMMON_EXCLUDES } from "../workspace/layout/git-layout.js";
import { projectDirComplaint, projectDirOf, seedsStarterSite } from "./project-dir.js";

// testConfig's workspace root is the container's own, so a value built on it reads as `ic` would hand it over.
const withProjectDir = (projectDir: string): Config => ({ ...testConfig, sandbox: { ...testConfig.sandbox, projectDir } });
const under = (rest: string): string => `${WORKSPACE_ROOT}${rest}`;

// The whole refusal, rule included: an operator reading `docker logs` has only this line to fix the env from.
const refusal = (value: string): string =>
    `SANDBOX_PROJECT_DIR=${value} is not a project folder: it must be ${WORKSPACE_ROOT}/<name>, one folder directly under the ` +
    `workspace root, whose name starts with a letter or digit, holds only letters, digits, '.', '_' and '-', is at most ` +
    `64 characters long, and is none of the names the daemon keeps for itself (${RESERVED_PROJECT_DIR_NAMES.join(", ")})`;

test("a sandbox given no project folder has none, seeds its starter site, and has nothing to refuse", () => {
    const config = withProjectDir("");
    expect(projectDirOf(config)).toBeUndefined();
    expect(seedsStarterSite(config)).toBe(true);
    expect(projectDirComplaint(config)).toBeUndefined();
});

test("a folder directly under the workspace root is the project, named relative to it, and no starter site joins it", () => {
    const config = withProjectDir(under("/my-app"));
    expect(projectDirOf(config)).toBe("my-app");
    expect(seedsStarterSite(config)).toBe(false);
    expect(projectDirComplaint(config)).toBeUndefined();
});

test("a name of 64 characters is a project folder, and one of 65 is refused", () => {
    const longest = "a".repeat(64);
    expect(projectDirOf(withProjectDir(under(`/${longest}`)))).toBe(longest);
    expect(projectDirComplaint(withProjectDir(under(`/${longest}a`)))).toBe(refusal(under(`/${longest}a`)));
});

// Each is somewhere the owner's folder must never land: the root itself, a name the daemon keeps for its own, a path
// that is not one folder under the root, a name an argv or a dot-file reader would misread.
test.each([
    under(""),
    under("/"),
    under("/my-app/"),
    under("/public"),
    under("/site"),
    under("/AGENTS.md"),
    under("/.intentic"),
    under("/-rf"),
    under("/my app"),
    under("/my-app/src"),
    "/home/me/my-app",
    "my-app",
])("SANDBOX_PROJECT_DIR=%s is refused, naming the value and the rule", (value) => {
    const config = withProjectDir(value);
    expect(projectDirOf(config)).toBeUndefined();
    expect(projectDirComplaint(config)).toBe(refusal(value));
});

// A project folder is only ever one under the root this daemon was configured with, never a /work it assumes.
test("the folder is read against the configured workspace root", () => {
    const config: Config = { ...withProjectDir("/srv/work/my-app"), workspaceRoot: "/srv/work" };
    expect(projectDirOf(config)).toBe("my-app");
    expect(projectDirOf({ ...config, sandbox: { ...config.sandbox, projectDir: under("/my-app") } })).toBeUndefined();
});

// The contract spells its reserved names without this package's vocabulary, so this holds it to it: a project folder
// can be none of the names every walk of the workspace skips or every git scope leaves out (it would sync and never be
// seen), nor any top-level name repo discovery or the boot keeps for the daemon.
test("no project folder can be a name the daemon walks past or keeps for itself", () => {
    const plainExcludes = COMMON_EXCLUDES.filter((pattern) => !/[*!]/.test(pattern));
    const daemonNames = [...IGNORED_DIRS, ...plainExcludes, ...REPO_ROLES, "root", REFERENCE_DIR, PUBLIC_DIR, STARTER_REPO, MEMORY_FILE];
    expect(daemonNames.filter((name) => isProjectDirName(name))).toEqual([]);
});

// This computer's own sandbox, which folders attach to later: no folder of its own, and no starter site beside theirs.
const projectsHost = (projectDir = ""): Config => ({ ...testConfig, sandbox: { ...testConfig.sandbox, projectDir, projectsHost: true } });

test("a projects host has no folder of its own, seeds no starter site, and has nothing to refuse", () => {
    const config = projectsHost();
    expect(projectDirOf(config)).toBeUndefined();
    expect(seedsStarterSite(config)).toBe(false);
    expect(projectDirComplaint(config)).toBeUndefined();
});

// One folder's sandbox or the one folders attach to, never both: the boot is refused, naming both variables.
test.each([under("/my-app"), under("/public")])("SANDBOX_PROJECT_DIR=%s beside SANDBOX_PROJECTS_HOST is refused", (value) => {
    expect(projectDirComplaint(projectsHost(value))).toBe(
        `SANDBOX_PROJECT_DIR=${value} and SANDBOX_PROJECTS_HOST are both set: a sandbox is made for one folder, or is this ` +
            `computer's own sandbox that folders attach to, never both`,
    );
});
