import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MEMORY_FILE } from "@intentic/constants";
import type { DevicePairing, DeviceReport } from "@intentic/sandbox-contract";
import { createLogger } from "../logger.js";
import { attachedProjects, registerProject } from "../system/projects-registry.js";
import { repoGitDir } from "../workspace/layout/git-layout.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";
import { workspacePaths } from "../workspace/workspace.js";
import { projectNote } from "./project-note.js";
import { attachReportedProjects, convergeAttachedProjects, projectsHostAttacher, type ProjectsHostDeps } from "./projects-host.js";

// Against real git in the container layout (a workspace root and a history root beside it): a projects host taking in
// the folders its computer's sync report names, and a boot taking them in again.

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const host = async (): Promise<ProjectsHostDeps & { readonly root: string }> => {
    const base = await mkdtemp(join(tmpdir(), "projects-host-"));
    tempDirs.push(base);
    const root = join(base, "work");
    await mkdir(root, { recursive: true });
    return { root, workspace: workspacePaths(root), historyRoot: join(base, "history"), logger, writesNote: true };
};

const SANDBOX = "sandbox-abc";
// The projects host's own folderless pairing, and a folder of the owner's attached to it.
const HOST_PAIRING: DevicePairing = { sandboxId: SANDBOX, mode: "sync", projectsHost: true };
const attached = (name: string): DevicePairing => ({ sandboxId: SANDBOX, mode: "sync", localDir: `/home/ada/${name}`, remoteDir: `/work/${name}`, deliver: "auto" });

const report = (...pairings: DevicePairing[]): DeviceReport => ({
    hostname: "ada-laptop",
    os: "linux",
    pairings: [HOST_PAIRING, ...pairings],
    ports: [],
    agent: { running: true },
    capturedAt: 1,
});

const note = (root: string, names: [string, ...string[]]): string => {
    const [first, ...rest] = names;
    return `<!-- intentic:project:start -->\n${projectNote([join(root, first), ...rest.map((name) => join(root, name))])}\n<!-- intentic:project:end -->\n`;
};

test("a folder a report names is made a repo, registered, and named in the note", async () => {
    const deps = await host();
    // File sync got there first: the owner's files are already in the folder.
    await mkdir(join(deps.root, "blog"));
    await writeFile(join(deps.root, "blog", "index.html"), "<h1>hi</h1>\n");

    expect(await attachReportedProjects(deps, report(attached("blog")))).toEqual(["blog"]);

    expect(await attachedProjects(deps.historyRoot)).toEqual(["blog"]);
    expect(await git(join(deps.root, "blog"), "rev-parse", "--absolute-git-dir")).toBe(repoGitDir(deps.historyRoot, "blog"));
    expect(await git(join(deps.root, "blog"), "status", "--porcelain")).toBe("?? index.html");
    expect(await discoverRepos(deps.root)).toEqual(["blog"]);
    expect(await readFile(join(deps.root, MEMORY_FILE), "utf8")).toBe(note(deps.root, ["blog"]));
});

// Nearly every report is this one: the folders it names are attached already.
test("a report naming nothing new changes nothing, and one naming no folder writes no file", async () => {
    const deps = await host();
    expect(await attachReportedProjects(deps, report())).toEqual([]);
    await expect(stat(join(deps.historyRoot, "projects.json"))).rejects.toThrow();
    await expect(stat(join(deps.root, MEMORY_FILE))).rejects.toThrow();

    await attachReportedProjects(deps, report(attached("blog")));
    const before = await stat(join(deps.root, MEMORY_FILE));
    const pointer = await readFile(join(deps.root, "blog", ".git"), "utf8");

    expect(await attachReportedProjects(deps, report(attached("blog")))).toEqual([]);

    expect((await stat(join(deps.root, MEMORY_FILE))).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(join(deps.root, "blog", ".git"), "utf8")).toBe(pointer);
});

test("a second folder joins the first: both repos, both registered, one note naming both", async () => {
    const deps = await host();
    await attachReportedProjects(deps, report(attached("blog")));

    expect(await attachReportedProjects(deps, report(attached("blog"), attached("api")))).toEqual(["api"]);

    expect(await attachedProjects(deps.historyRoot)).toEqual(["blog", "api"]);
    expect(await discoverRepos(deps.root)).toEqual(["api", "blog"]);
    expect(await readFile(join(deps.root, MEMORY_FILE), "utf8")).toBe(note(deps.root, ["blog", "api"]));
});

// Registered only once its repo stands, so the next report retries rather than finding it already attached.
test("a folder whose repo could not be made is not registered, and the next report attaches it", async () => {
    const deps = await host();
    const refusing = { ...deps, git: () => Promise.reject(new Error("git is not answering")) };

    expect(await attachReportedProjects(refusing, report(attached("blog")))).toEqual([]);
    expect(await attachedProjects(deps.historyRoot)).toEqual([]);
    await expect(stat(join(deps.root, MEMORY_FILE))).rejects.toThrow();

    expect(await attachReportedProjects(deps, report(attached("blog")))).toEqual(["blog"]);
});

// The machine agent reports every few seconds, so a new folder is named by several reports before the first is done.
test("reports handed over together attach in turn, each folder once", async () => {
    const deps = await host();
    const attach = projectsHostAttacher(deps);

    await Promise.all([attach(report(attached("blog"))), attach(report(attached("blog"))), attach(report(attached("blog"), attached("api")))]);

    expect(await attachedProjects(deps.historyRoot)).toEqual(["blog", "api"]);
    expect(await readFile(join(deps.root, MEMORY_FILE), "utf8")).toBe(note(deps.root, ["blog", "api"]));
});

test("a failed attach is said, and the queue goes on to the next report", async () => {
    const deps = await host();
    const said: string[] = [];
    const quiet: ProjectsHostDeps = { ...deps, logger: { info: () => undefined, warn: (_fields, message) => void said.push(message) } };
    const attach = projectsHostAttacher({ ...quiet, git: () => Promise.reject(new Error("git is not answering")) });

    await attach(report(attached("blog")));

    expect(said).toEqual(["attached project folder not made a repo, the next report from its computer tries again"]);
    await projectsHostAttacher(deps)(report(attached("blog")));
    expect(await attachedProjects(deps.historyRoot)).toEqual(["blog"]);
});

// What the boot step does: every registered folder's repo and the note, again. A recreate keeps /history and /work, but
// an agent's `rm .git` or a note edited away is put back, and a second boot finds nothing to do.
test("a boot puts every registered folder's repo and the note back, and a second boot changes nothing", async () => {
    const deps = await host();
    await registerProject(deps.historyRoot, "blog");
    await registerProject(deps.historyRoot, "api");
    await writeFile(join(deps.root, MEMORY_FILE), "# House rules\n");

    await convergeAttachedProjects(deps);

    expect(await discoverRepos(deps.root)).toEqual(["api", "blog"]);
    expect(await readFile(join(deps.root, MEMORY_FILE), "utf8")).toBe(`# House rules\n\n${note(deps.root, ["blog", "api"])}`);

    await rm(join(deps.root, "blog", ".git"));
    await convergeAttachedProjects(deps);
    expect(await readFile(join(deps.root, "blog", ".git"), "utf8")).toBe(`gitdir: ${repoGitDir(deps.historyRoot, "blog")}\n`);

    const before = await stat(join(deps.root, MEMORY_FILE));
    const pointers = await Promise.all(["blog", "api"].map((name) => readFile(join(deps.root, name, ".git"), "utf8")));
    await convergeAttachedProjects(deps);
    expect((await stat(join(deps.root, MEMORY_FILE))).mtimeMs).toBe(before.mtimeMs);
    expect(await Promise.all(["blog", "api"].map((name) => readFile(join(deps.root, name, ".git"), "utf8")))).toEqual(pointers);
});

test("a boot of a projects host nothing has attached to yet writes nothing", async () => {
    const deps = await host();

    await convergeAttachedProjects(deps);

    await expect(stat(join(deps.root, MEMORY_FILE))).rejects.toThrow();
    expect(await discoverRepos(deps.root)).toEqual([]);
});

// A daemon that does not own the workspace's agent-facing config makes the repos and leaves AGENTS.md alone.
test("the note is left alone where this daemon does not write the workspace's config", async () => {
    const deps = { ...(await host()), writesNote: false };

    expect(await attachReportedProjects(deps, report(attached("blog")))).toEqual(["blog"]);

    await expect(stat(join(deps.root, MEMORY_FILE))).rejects.toThrow();
    expect(await discoverRepos(deps.root)).toEqual(["blog"]);
});
