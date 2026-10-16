import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { DevicePairing, DeviceReport } from "@intentic/sandbox-contract/schemas/devices";
import {
    attachedProjectEntries,
    attachedProjects,
    attachedProjectsDocument,
    placeProjects,
    registerProject,
    reportedProjects,
} from "./projects-registry.js";

// Against a real history root on disk: the registry is the one record of which folders a projects host has taken in.

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const historyRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "projects-registry-"));
    tempDirs.push(root);
    return root;
};

const report = (pairings: DevicePairing[]): DeviceReport => ({
    hostname: "ada-laptop",
    os: "linux",
    pairings,
    ports: [],
    agent: { running: true },
    capturedAt: 1,
});

test("a projects host nothing has attached to has no folders, and no file until one attaches", async () => {
    const root = await historyRoot();

    expect(await attachedProjects(root)).toEqual([]);
    await expect(readFile(join(root, attachedProjectsDocument.path), "utf8")).rejects.toThrow();
});

test("each folder is registered once, in the order they attached, and a second registration writes nothing", async () => {
    const root = await historyRoot();

    expect(await registerProject(root, "blog", 1)).toBe(true);
    expect(await registerProject(root, "api", 2)).toBe(true);
    const written = await readFile(join(root, attachedProjectsDocument.path), "utf8");
    expect(await registerProject(root, "blog", 3)).toBe(false);

    expect(await attachedProjects(root)).toEqual(["blog", "api"]);
    // The first attach's moment stands: the file was not rewritten.
    expect(await readFile(join(root, attachedProjectsDocument.path), "utf8")).toBe(written);
    expect(JSON.parse(written)).toEqual([
        { name: "blog", attachedAt: 1 },
        { name: "api", attachedAt: 2 },
    ]);
});

// A name the daemon keeps for itself, or one that is not a single path segment, would be joined onto the workspace root.
test.each(["public", "AGENTS.md", "../etc", "a/b", STATE_DIR, ""])("%j is never registered", async (name) => {
    const root = await historyRoot();

    expect(await registerProject(root, name)).toBe(false);
    expect(await attachedProjects(root)).toEqual([]);
});

test("an entry edited by hand into a name no project may take is left out of the folders", async () => {
    const root = await historyRoot();
    await writeFile(
        join(root, attachedProjectsDocument.path),
        JSON.stringify([
            { name: "blog", attachedAt: 1 },
            { name: "public", attachedAt: 2 },
        ]),
    );

    expect(await attachedProjects(root)).toEqual(["blog"]);
});

test("a report names the folders it syncs into /work/<name>, once each, and nothing else", () => {
    const sandboxId = "sandbox-abc";
    expect(
        reportedProjects(
            report([
                // The projects host's own pairing: no folder, only the token its folders sync under.
                { sandboxId, mode: "sync", projectsHost: true },
                { sandboxId, mode: "sync", localDir: "/home/ada/blog", remoteDir: `${WORKSPACE_ROOT}/blog`, deliver: "auto" },
                { sandboxId, mode: "sync", localDir: "/home/ada/api", remoteDir: `${WORKSPACE_ROOT}/api` },
                // Reported twice (a re-attach mid-report) is still one folder.
                { sandboxId, mode: "sync", localDir: "/home/ada/blog", remoteDir: `${WORKSPACE_ROOT}/blog` },
                // A pairing of /work itself, a ports-only one, and a folder no project may take name none.
                { sandboxId, mode: "sync", localDir: "/home/ada/intentic/abc" },
                { sandboxId, mode: "sync", localDir: "/home/ada/whole", remoteDir: WORKSPACE_ROOT },
                { sandboxId, mode: "mirror", remoteDir: `${WORKSPACE_ROOT}/ports` },
                { sandboxId, mode: "sync", localDir: "/home/ada/x", remoteDir: `${WORKSPACE_ROOT}/public` },
                { sandboxId, mode: "sync", localDir: "/home/ada/y", remoteDir: `${WORKSPACE_ROOT}/a/b` },
            ]),
        ),
    ).toEqual([
        { name: "blog", hostPath: "/home/ada/blog", machine: "ada-laptop" },
        { name: "api", hostPath: "/home/ada/api", machine: "ada-laptop" },
    ]);
    expect(reportedProjects(report([]))).toEqual([]);
});

// A Windows folder and a WSL distro's are named as the machine agent names them, never rewritten here.
test("a report's folder keeps its place as the computer spells it", () => {
    const sandboxId = "sandbox-abc";
    expect(
        reportedProjects(
            report([
                { sandboxId, mode: "sync", localDir: "C:\\Users\\ada\\code\\app", remoteDir: `${WORKSPACE_ROOT}/code-app` },
                { sandboxId, mode: "sync", localDir: "\\\\wsl.localhost\\arch\\home\\ada\\api", remoteDir: `${WORKSPACE_ROOT}/api` },
                { sandboxId, mode: "sync", remoteDir: `${WORKSPACE_ROOT}/docs` },
            ]),
        ),
    ).toEqual([
        { name: "code-app", hostPath: "C:\\Users\\ada\\code\\app", machine: "ada-laptop" },
        { name: "api", hostPath: "\\\\wsl.localhost\\arch\\home\\ada\\api", machine: "ada-laptop" },
        { name: "docs", machine: "ada-laptop" },
    ]);
});

test("a folder is kept with where it is, and a report that moves it rewrites the entry only then", async () => {
    const root = await historyRoot();
    expect(await registerProject(root, "blog", 1, { hostPath: "/home/ada/blog", machine: "ada-laptop" })).toBe(true);
    expect(await registerProject(root, "api", 2)).toBe(true);
    const written = await readFile(join(root, attachedProjectsDocument.path), "utf8");

    // What is kept already, or a folder nobody attached, writes nothing.
    expect(await placeProjects(root, [{ name: "blog", hostPath: "/home/ada/blog", machine: "ada-laptop" }, { name: "docs", hostPath: "/x" }])).toBe(false);
    expect(await readFile(join(root, attachedProjectsDocument.path), "utf8")).toBe(written);

    expect(await placeProjects(root, [{ name: "blog", hostPath: "/home/ada/sites/blog" }, { name: "api", hostPath: "/home/ada/api", machine: "ada-laptop" }])).toBe(true);
    expect(await attachedProjectEntries(root)).toEqual([
        { name: "blog", attachedAt: 1, hostPath: "/home/ada/sites/blog", machine: "ada-laptop" },
        { name: "api", attachedAt: 2, hostPath: "/home/ada/api", machine: "ada-laptop" },
    ]);
});
