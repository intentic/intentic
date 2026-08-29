import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultGit } from "@intentic/scaffold";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { fakeFiles, memoryCapabilitiesStore, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createDefinitions } from "./apply-definition.js";
import { convergeDefinitionFile, definitionFilePath } from "./definition-file.js";
import { parseDefinitionToml } from "./definition.js";

/* THE MATERIALIZED DEFINITION, on real disk: what the daemon leaves at the workspace root, that it stays a
 * PARSEABLE definition rather than a pretty report, that its managed header is on this copy and no other, and
 * that a converge over an unchanged sandbox writes nothing at all.
 *
 * The last one is the load-bearing test. The converge runs on a five-minute patrol, so a pass that rewrote
 * identical bytes would tick the file's mtime forever: a file watcher event every five minutes, and a Changes
 * review that is never clean on a sandbox nobody has touched. */

const roots: string[] = [];
const makeRoots = async (): Promise<{ work: string; history: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-definition-file-"));
    roots.push(dir);
    const work = join(dir, "work");
    const history = join(dir, "history");
    await mkdir(work, { recursive: true });
    await mkdir(history, { recursive: true });
    return { work, history };
};

const cleanup = async (): Promise<void> => {
    for (const dir of roots.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
};

const filesOnDisk = (): Services["files"] =>
    fakeFiles({
        read: async (absPath) => readFile(absPath, "utf8").catch(() => undefined),
        write: async (absPath, content) => {
            await mkdir(dirname(absPath), { recursive: true });
            await writeFile(absPath, content);
        },
        remove: async (absPath) => {
            await rm(absPath, { recursive: true, force: true });
        },
    });

const servicesFor = (dirs: { work: string; history: string }): Services =>
    services({
        workspace: workspacePaths(dirs.work),
        config: { ...testConfig, workspaceRoot: dirs.work, historyRoot: dirs.history },
        files: filesOnDisk(),
        capabilities: memoryCapabilitiesStore(),
        vaultManifestSecrets: async () => [],
        vaultExtensionSettingSecrets: async () => [],
        ensurePreviewRoutes: async () => {},
    } as Parameters<typeof services>[0]);

const makeRepo = async (parent: string, name: string, remote: string): Promise<void> => {
    const dir = join(parent, name);
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "-b", "main"]);
    await writeFile(join(dir, "README.md"), `# ${name}\n`);
    await defaultGit(dir, ["add", "."]);
    await defaultGit(dir, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "first"]);
    await defaultGit(dir, ["remote", "add", "origin", remote]);
};

test("writes sandbox.toml at the workspace root, and what it writes parses back as a definition", async () => {
    const dirs = await makeRoots();
    await makeRepo(dirs.work, "app", "https://github.com/example/app.git");
    await mkdir(join(dirs.work, ".intentic/config"), { recursive: true });
    await writeFile(join(dirs.work, ".intentic/config/environment.custom.Dockerfile"), "RUN apt-get install -y ffmpeg\n");

    await convergeDefinitionFile(servicesFor(dirs));

    const toml = await readFile(definitionFilePath(dirs.work), "utf8");
    // The point of the file: an agent or a reader finds the sandbox's shape in it, and a target can apply it.
    const parsed = parseDefinitionToml(toml);
    expect(parsed.repositories.map((repo) => repo.remote)).toEqual(["https://github.com/example/app.git"]);
    expect(parsed.environment.dockerfile).toContain("ffmpeg");
    await cleanup();
});

test("the managed header rides this copy only: a downloaded definition is the reader's to edit", async () => {
    const dirs = await makeRoots();
    await convergeDefinitionFile(servicesFor(dirs));

    const onDisk = await readFile(definitionFilePath(dirs.work), "utf8");
    expect(onDisk).toContain("Managed by the sandbox");
    // The same derivation through the download door, which is the one every other caller uses.
    const { toml } = await createDefinitions(servicesFor(dirs)).derive();
    expect(toml).not.toContain("Managed by the sandbox");
    await cleanup();
});

test("an unchanged sandbox is not rewritten: the patrol leaves the file, and its mtime, alone", async () => {
    const dirs = await makeRoots();
    await makeRepo(dirs.work, "app", "https://github.com/example/app.git");
    const held = servicesFor(dirs);

    await convergeDefinitionFile(held);
    const first = await stat(definitionFilePath(dirs.work));
    // Far enough apart that a rewrite could not land on the same millisecond and pass by luck.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await convergeDefinitionFile(held);
    const second = await stat(definitionFilePath(dirs.work));

    expect(second.mtimeMs).toBe(first.mtimeMs);
    await cleanup();
});

test("a shape that changed is written through: the file follows the sandbox, not the other way round", async () => {
    const dirs = await makeRoots();
    await makeRepo(dirs.work, "app", "https://github.com/example/app.git");
    const held = servicesFor(dirs);
    await convergeDefinitionFile(held);
    expect(await readFile(definitionFilePath(dirs.work), "utf8")).not.toContain("example/second");

    await makeRepo(dirs.work, "second", "https://github.com/example/second.git");
    await convergeDefinitionFile(held);

    expect(await readFile(definitionFilePath(dirs.work), "utf8")).toContain("https://github.com/example/second.git");
    await cleanup();
});

test("the file is derived, never a source: deleting it changes nothing and the next converge restores it", async () => {
    const dirs = await makeRoots();
    await makeRepo(dirs.work, "app", "https://github.com/example/app.git");
    const held = servicesFor(dirs);
    await convergeDefinitionFile(held);
    const written = await readFile(definitionFilePath(dirs.work), "utf8");

    await rm(definitionFilePath(dirs.work));
    // The derivation is what the product runs on, and it never looked at the file.
    const { toml } = await createDefinitions(held).derive();
    expect(toml).toContain("https://github.com/example/app.git");

    await convergeDefinitionFile(held);
    expect(await readFile(definitionFilePath(dirs.work), "utf8")).toBe(written);
    await cleanup();
});
