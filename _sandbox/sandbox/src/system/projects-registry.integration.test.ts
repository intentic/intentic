import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevicePairing, DeviceReport } from "@intentic/sandbox-contract";
import { attachedProjects, attachedProjectsDocument, registerProject, reportedProjects } from "./projects-registry.js";

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
test.each(["public", "AGENTS.md", "../etc", "a/b", ".intentic", ""])("%j is never registered", async (name) => {
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
                { sandboxId, mode: "sync", localDir: "/home/ada/blog", remoteDir: "/work/blog", deliver: "auto" },
                { sandboxId, mode: "sync", localDir: "/home/ada/api", remoteDir: "/work/api" },
                // Reported twice (a re-attach mid-report) is still one folder.
                { sandboxId, mode: "sync", localDir: "/home/ada/blog", remoteDir: "/work/blog" },
                // A pairing of /work itself, a ports-only one, and a folder no project may take name none.
                { sandboxId, mode: "sync", localDir: "/home/ada/intentic/abc" },
                { sandboxId, mode: "sync", localDir: "/home/ada/whole", remoteDir: "/work" },
                { sandboxId, mode: "mirror", remoteDir: "/work/ports" },
                { sandboxId, mode: "sync", localDir: "/home/ada/x", remoteDir: "/work/public" },
                { sandboxId, mode: "sync", localDir: "/home/ada/y", remoteDir: "/work/a/b" },
            ]),
        ),
    ).toEqual(["blog", "api"]);
    expect(reportedProjects(report([]))).toEqual([]);
});
