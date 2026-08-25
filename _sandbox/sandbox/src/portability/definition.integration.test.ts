import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Capability, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { defaultGit, gitClone } from "@intentic/scaffold";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { fakeFiles, memoryCapabilitiesStore, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { applyDefinitionItems, createDefinitions } from "./apply-definition.js";
import { deriveDefinition, parseDefinitionToml } from "./definition.js";

/* THE DEFINITION ROUND TRIP ON REAL DISK AND REAL GIT: derive a sandbox.toml from a workspace with live
 * repos, land it in an empty one, and check that what the target holds is what the document said — plus the
 * two refusals the surface promises (a remoteless repo never becomes a reference; an occupied id is never
 * overwritten). The pure format halves live in definition.test.ts; this suite is the seams: git remotes,
 * the daemon-shaped clone (separate git dir), the stores the apply writes through. */

const roots: string[] = [];
const makeRoots = async (): Promise<{ work: string; history: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-definition-"));
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

// A real repo with one commit, so branches and remotes answer as they do in production.
const makeRepo = async (parent: string, name: string, remote?: string): Promise<string> => {
    const dir = join(parent, name);
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "-b", "main"]);
    await writeFile(join(dir, "README.md"), `# ${name}\n`);
    await defaultGit(dir, ["add", "."]);
    await defaultGit(dir, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "first"]);
    if (remote !== undefined) {
        await defaultGit(dir, ["remote", "add", "origin", remote]);
    }
    return dir;
};

const filesOnDisk = (): Services["files"] =>
    fakeFiles({
        read: async (absPath) => readFile(absPath, "utf8").catch(() => undefined),
        write: async (absPath, content) => {
            await mkdir(dirname(absPath), { recursive: true });
            await writeFile(absPath, content);
        },
    });

const servicesFor = (dirs: { work: string; history: string }, overrides: Record<string, unknown> = {}): Services =>
    services({
        workspace: workspacePaths(dirs.work),
        config: { ...testConfig, workspaceRoot: dirs.work, historyRoot: dirs.history },
        files: filesOnDisk(),
        capabilities: memoryCapabilitiesStore(),
        vaultManifestSecrets: async () => [],
        vaultExtensionSettingSecrets: async () => [],
        ensurePreviewRoutes: async () => {},
        ...overrides,
    } as Parameters<typeof services>[0]);

test("derive reads the live stores: remotes become references, a remoteless repo is omitted with its reason", async () => {
    const source = await makeRoots();
    await makeRepo(source.work, "app", "https://github.com/example/app.git");
    await makeRepo(source.work, "scratch");
    await mkdir(join(source.work, ".intentic/config"), { recursive: true });
    await writeFile(join(source.work, ".intentic/config/environment.custom.Dockerfile"), "RUN apt-get install -y ffmpeg\n");

    const sourceServices = servicesFor(source, {
        capabilities: memoryCapabilitiesStore([{ id: "linear", kind: "mcp", config: { url: "https://mcp.linear.app/sse" } } as Capability]),
        sandboxSettings: { get: async () => SandboxSettingsSchema.parse({ workspaceMap: true }) },
        secretRegistry: async () => [{ name: "OPENAI_API_KEY", value: "sk-test", source: "env" as const }],
    });
    const { definition, omitted } = await deriveDefinition(sourceServices);

    expect(definition.repositories).toEqual([{ id: "app", remote: "https://github.com/example/app.git", ref: "main" }]);
    expect(omitted.map((entry) => entry.subject)).toContain("Repository scratch");
    expect(definition.capabilities.map((capability) => capability.id)).toEqual(["linear"]);
    expect(definition.secrets).toEqual(["OPENAI_API_KEY"]);
    // Only the non-default settings, so a definition never freezes today's defaults into future applies.
    expect(definition.settings).toEqual({ workspaceMap: true });
    expect(definition.environment.dockerfile).toBe("RUN apt-get install -y ffmpeg\n");
    await cleanup();
});

test("plan → apply lands every piece through the native paths, and a re-plan marks them inapplicable", async () => {
    // The clone source is a real local repo, standing in for the remote a published definition would name.
    const upstream = await makeRoots();
    const upstreamDir = await makeRepo(upstream.work, "app");

    const target = await makeRoots();
    let settings = SandboxSettingsSchema.parse({});
    const targetServices = servicesFor(target, {
        git: { clone: gitClone },
        sandboxSettings: {
            get: async () => settings,
            set: async (next: typeof settings) => {
                settings = next;
            },
        },
    });
    const definitions = createDefinitions(targetServices);

    const toml = [
        "schemaVersion = 1",
        'secrets = ["OPENAI_API_KEY"]',
        "",
        "[environment]",
        "dockerfile = '''",
        "RUN apt-get install -y ffmpeg",
        "'''",
        "",
        "[settings]",
        "workspaceMap = true",
        "",
        "[[repositories]]",
        'id = "app"',
        `remote = ${JSON.stringify(upstreamDir)}`,
        'ref = "main"',
        "",
        "[[capabilities]]",
        'id = "linear"',
        'kind = "mcp"',
        'config = { url = "https://mcp.linear.app/sse" }',
        "",
    ].join("\n");

    const plan = await definitions.plan(toml);
    expect(plan.items.map((item) => [item.id, item.applicable])).toEqual([
        ["repo:app", true],
        ["environment", true],
        ["capability:linear", true],
        ["settings", true],
    ]);
    // The preview already says what no apply can do: the approval gate and the credentials.
    expect(plan.needsAction.map((action) => action.subject)).toEqual([
        "Approve and rebuild the environment",
        "Reconnect capabilities",
        "Enter secret values",
    ]);

    const report = await definitions.apply({ token: plan.token, items: plan.items.map((item) => item.id) });
    expect(report.failed).toEqual([]);
    expect(report.applied.map((entry) => entry.id)).toEqual(["repo:app", "environment", "capability:linear", "settings"]);

    // The repo arrived in the daemon's own shape: a checkout whose real git dir lives on /history.
    expect(await readFile(join(target.work, "app/README.md"), "utf8")).toBe("# app\n");
    expect((await readFile(join(target.work, "app/.git"), "utf8")).trim().startsWith("gitdir:")).toBe(true);
    expect(existsSync(join(target.history, "gits/app"))).toBe(true);
    // The overlay landed as a DRAFT for the approval gate, never as the approved custom section.
    expect(await readFile(join(target.work, ".intentic/config/environment.d/definition.Dockerfile"), "utf8")).toBe(
        "RUN apt-get install -y ffmpeg\n",
    );
    expect(existsSync(join(target.work, ".intentic/config/environment.custom.Dockerfile"))).toBe(false);
    // The capability is the manifest entry, present and unauthenticated; settings merged over the defaults.
    expect((await targetServices.capabilities.get("linear"))?.kind).toBe("mcp");
    expect(settings.workspaceMap).toBe(true);

    // Landing beside, never over: the same document again plans everything already-there as inapplicable.
    const replan = await definitions.plan(toml);
    expect(replan.items.find((item) => item.id === "repo:app")?.applicable).toBe(false);
    expect(replan.items.find((item) => item.id === "capability:linear")?.applicable).toBe(false);
    await cleanup();
});

test("a stale or consumed token is refused, and the boot-seed path applies everything applicable", async () => {
    const upstream = await makeRoots();
    const upstreamDir = await makeRepo(upstream.work, "app");

    const target = await makeRoots();
    const targetServices = servicesFor(target, { git: { clone: gitClone } });
    const definitions = createDefinitions(targetServices);
    const toml = ["schemaVersion = 1", "[[repositories]]", 'id = "app"', `remote = ${JSON.stringify(upstreamDir)}`, ""].join("\n");

    const plan = await definitions.plan(toml);
    await definitions.apply({ token: plan.token, items: [] });
    // Consumed on apply, the migration surface's rule: the second apply must re-plan.
    await expect(definitions.apply({ token: plan.token, items: [] })).rejects.toThrow(/no held definition/);

    // The seed door: no browser, no token, everything applicable lands (main.ts's definitionSeed step).
    const seeded = await makeRoots();
    const seededServices = servicesFor(seeded, { git: { clone: gitClone } });
    const report = await applyDefinitionItems(seededServices, parseDefinitionToml(toml), () => true);
    expect(report.failed).toEqual([]);
    expect(existsSync(join(seeded.work, "app/README.md"))).toBe(true);
    await cleanup();
});
