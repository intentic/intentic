import { mkdtempSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { buildApplication, buildRouteMap, run } from "@stricli/core";

// What the desktop app reads: exactly one JSON object on stdout per command, `{ ok: false, error }` and exit code 1 on
// failure. config.ts fixes its paths at import time, so HOME points at a throwaway dir before the imports below.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "project-commands-"));
process.env["USERPROFILE"] = process.env["HOME"];
const home = process.env["HOME"];
const { agentHome } = await import("@intentic/local-agent");
const { readState } = await import("./config.js");
const { projectCommands, requestedPaths } = await import("./project-commands.js");
const { restoreDir } = await import("./restore-points.js");

// The scanner as the real app configures it (app.ts), so `--paths-file` reaches `pathsFile`.
const app = buildApplication(buildRouteMap({ routes: projectCommands, docs: { brief: "copy-first project commands" } }), {
    name: "intentic-machine",
    scanner: { caseStyle: "allow-kebab-for-camel" },
});
const machineDir = agentHome("machine").dir;
const project = join(home, "code", "app");
const workspace = join(home, "intentic", "sandbox-w");

beforeAll(async () => {
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await symlink(project, join(home, "app-link"));
    await mkdir(machineDir, { recursive: true });
    const pairings = [
        { sandboxUrl: "https://sandbox-p.example.dev", sandboxId: "sandbox-p", mode: "sync", localDir: project, remoteDir: `${WORKSPACE_ROOT}/my-app`, project: true, syncToken: "t1" },
        { sandboxUrl: "https://sandbox-w.example.dev", sandboxId: "sandbox-w", mode: "sync", localDir: workspace, syncToken: "t2" },
    ];
    await writeFile(join(machineDir, "sync.json"), JSON.stringify({ pairings }));
});

// A failing command sets the process's own exit code, as the real CLI must; the test process is not the one failing.
afterEach(() => {
    process.exitCode = 0;
});

const cli = async (...args: string[]): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | string | null | undefined }> => {
    const out: string[] = [];
    const err: string[] = [];
    process.exitCode = 0;
    await run(app, args, { process: { stdout: { write: (text: string) => void out.push(text) }, stderr: { write: (text: string) => void err.push(text) } } });
    return { stdout: out.join(""), stderr: err.join(""), exitCode: process.exitCode };
};

describe("sync direction", () => {
    it("switches a project both ways and back, answering in one JSON object, and keeps the rest of the pairing", async () => {
        expect(await cli("direction", "both", "--dir", project, "--json")).toEqual({ stdout: `{"ok":true,"direction":"both"}\n`, stderr: "", exitCode: 0 });
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === "sandbox-p")).toEqual({
            sandboxUrl: "https://sandbox-p.example.dev",
            sandboxId: "sandbox-p",
            mode: "sync",
            localDir: project,
            remoteDir: `${WORKSPACE_ROOT}/my-app`,
            project: true,
            syncToken: "t1",
            direction: "both",
        });
        // Named through a link to it, the folder is still the project's.
        expect((await cli("direction", "to-sandbox", "--dir", join(home, "app-link"), "--json")).stdout).toBe(`{"ok":true,"direction":"to-sandbox"}\n`);
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === "sandbox-p")?.direction).toBe("to-sandbox");
    });

    it("says in words what it did without --json", async () => {
        const answer = await cli("direction", "both", "--dir", project);
        expect(answer.stdout).toContain(`${project} now syncs both ways`);
        expect(answer.exitCode).toBe(0);
    });

    it("refuses a direction it does not know, as JSON with exit code 1", async () => {
        expect(await cli("direction", "sideways", "--dir", project, "--json")).toEqual({
            stdout: `${JSON.stringify({ ok: false, error: 'Say which way: `to-sandbox` (copy-first) or `both`, not "sideways".' })}\n`,
            stderr: "",
            exitCode: 1,
        });
    });
});

describe("finding the project by its folder", () => {
    it("asks for --dir when it is missing", async () => {
        expect(await cli("changes", "--json")).toEqual({
            stdout: `${JSON.stringify({ ok: false, error: "Pass --dir with the project's folder on this machine." })}\n`,
            stderr: "",
            exitCode: 1,
        });
    });

    it("names a workspace's folder, a folder inside a project and an unknown folder for what they are", async () => {
        expect(JSON.parse((await cli("bring-back", "--dir", workspace, "--json")).stdout)).toEqual({
            ok: false,
            error: `${workspace} syncs with sandbox-w as its whole workspace, not as a project: only a project's changes are brought back.`,
        });
        expect(JSON.parse((await cli("restore", "--dir", join(project, "src"), "--point", "x", "--json")).stdout)).toEqual({
            ok: false,
            error: `${join(project, "src")} is inside the project folder ${project}: pass that folder.`,
        });
        expect(JSON.parse((await cli("restore-points", "--dir", join(home, "elsewhere"), "--json")).stdout)).toEqual({
            ok: false,
            error: `No project on this machine syncs ${join(home, "elsewhere")}.`,
        });
    });

    it("writes a failure's sentence to stderr without --json", async () => {
        expect(await cli("changes")).toEqual({ stdout: "", stderr: "Pass --dir with the project's folder on this machine.\n", exitCode: 1 });
    });
});

describe("sync restore-points", () => {
    it("lists this folder's points newest first, and none of another folder's", async () => {
        const dir = restoreDir(machineDir, "sandbox-p");
        const manifest = (id: string, createdAt: string, folder: string, entries: number) => ({
            id,
            createdAt,
            dir: folder,
            entries: Array.from({ length: entries }, (_, at) => ({ path: `f${at}`, kind: "added", backedUp: false, applied: "a".repeat(64) })),
        });
        for (const point of [manifest("20260927T100000.000Z", "2026-09-27T10:00:00.000Z", project, 2), manifest("20260928T100000.000Z", "2026-09-28T10:00:00.000Z", project, 1), manifest("20260926T100000.000Z", "2026-09-26T10:00:00.000Z", "/elsewhere", 1)]) {
            await mkdir(join(dir, point.id), { recursive: true });
            await writeFile(join(dir, point.id, "manifest.json"), JSON.stringify(point));
        }
        expect(JSON.parse((await cli("restore-points", "--dir", project, "--json")).stdout)).toEqual({
            ok: true,
            points: [
                { id: "20260928T100000.000Z", createdAt: "2026-09-28T10:00:00.000Z", entries: 1 },
                { id: "20260927T100000.000Z", createdAt: "2026-09-27T10:00:00.000Z", entries: 2 },
            ],
        });
        expect(await readFile(join(dir, "20260926T100000.000Z", "manifest.json"), "utf8")).toContain("/elsewhere");
    });
});

// A long review's selection does not fit a Windows command line (32,767 characters), so the app writes it to a file.
describe("sync bring-back --paths-file", () => {
    it("reads a JSON array of paths, a byte-order mark allowed, and takes it together with --path, each path once", async () => {
        const file = join(home, "selection.json");
        await writeFile(file, `\uFEFF${JSON.stringify(["src/a.ts", "docs", "src/a.ts"])}`);
        expect(await requestedPaths({ path: ["README.md", "docs"], pathsFile: file })).toEqual(["README.md", "docs", "src/a.ts"]);
        expect(await requestedPaths({ path: ["README.md"] })).toEqual(["README.md"]);
        expect(await requestedPaths({ pathsFile: file })).toEqual(["src/a.ts", "docs"]);
    });

    // Refused before anything is listed or fetched; an empty list above all, which would otherwise mean every change.
    it("answers a file it cannot make sense of as a failure", async () => {
        const bad = join(home, "bad.json");
        const cases: readonly (readonly [string, string])[] = [
            ["not json", "is not a JSON array of relative paths"],
            [JSON.stringify({ paths: ["a"] }), "is not a JSON array of relative paths"],
            [JSON.stringify(["a", ""]), "is not a JSON array of relative paths"],
            [JSON.stringify([]), "lists no paths: leave it out to bring every change back"],
        ];
        for (const [content, why] of cases) {
            await writeFile(bad, content);
            expect(await cli("bring-back", "--dir", project, "--paths-file", bad, "--json")).toEqual({
                stdout: `${JSON.stringify({ ok: false, error: `The paths file ${bad} ${why}.` })}\n`,
                stderr: "",
                exitCode: 1,
            });
        }
    });

    it("answers a file it cannot read as a failure", async () => {
        const missing = join(home, "missing.json");
        const answer = await cli("bring-back", "--dir", project, "--paths-file", missing, "--json");
        expect([JSON.parse(answer.stdout), answer.exitCode]).toEqual([
            { ok: false, error: `The paths file ${missing} could not be read (ENOENT: no such file or directory, open '${missing}').` },
            1,
        ]);
    });
});
