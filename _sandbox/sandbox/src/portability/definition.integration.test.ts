import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Capability, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { defaultGit, gitClone } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { fileAutomationsStore } from "../automations/automations-store.js";
import type { Services } from "../composition.js";
import { fakeFiles, memoryCapabilitiesStore, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { applyDefinitionItems, createDefinitions } from "./apply-definition.js";
import { deriveDefinition, parseDefinitionToml } from "./definition.js";
import { rootExcludes } from "../history/history.js";
import { ROOT_BASELINE_CONFIG, ROOT_FRESH_CONFIG } from "../git/root-repo.js";
import { workspaceRemoteUrl } from "./workspace-repo.js";

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
        remove: async (absPath) => {
            await rm(absPath, { recursive: true, force: true });
        },
    });

const AUTHOR = ["-c", "user.email=test@example.com", "-c", "user.name=test"];

// A workspace that is a REPO, the shape every real /work has: the daemon's own baseline commit and nothing
// else, unless the test asks for a history somebody has worked in.
const makeWorkspaceRepo = async (work: string, commits = 1): Promise<void> => {
    await defaultGit(work, ["init", "-b", "main"]);
    await writeFile(join(work, ".git/info/exclude"), `${rootExcludes([]).join("\n")}\n`);
    for (let index = 0; index < commits; index++) {
        if (index === 0) {
            await defaultGit(work, ["add", "-A"]);
        }
        await defaultGit(work, [...AUTHOR, "commit", "-q", "--allow-empty", "-m", index === 0 ? "Initialize workspace" : `later ${index}`]);
        if (index === 0) {
            await defaultGit(work, ["config", ROOT_BASELINE_CONFIG, (await defaultGit(work, ["rev-parse", "HEAD"])).stdout.trim()]);
        }
    }
};

/* A PUBLISHED workspace: a bare repo standing in for the host, holding one sandbox's own content — a note, a
 * skill, an enabled automation, a workspace extension and an approved overlay. The last three are the ones
 * that act by themselves, which is what the arrival has to switch off. */
const publishedWorkspace = async (mutate?: (work: string) => Promise<void>): Promise<string> => {
    const dirs = await makeRoots();
    const bare = join(dirs.history, "workspace.git");
    await defaultGit(dirs.history, ["init", "--bare", "-q", "-b", "main", bare]);
    const work = dirs.work;
    await defaultGit(work, ["init", "-b", "main"]);
    await writeFile(join(work, "notes.md"), "workspace notes\n");
    await mkdir(join(work, ".intentic/config/skills/mine"), { recursive: true });
    await writeFile(join(work, ".intentic/config/skills/mine/SKILL.md"), "# mine\n");
    await writeFile(
        join(work, ".intentic/config/automations.json"),
        JSON.stringify([{ id: "nightly", trigger: { kind: "schedule", cron: "0 9 * * *" }, prompt: "sweep the inbox", enabled: true }], null, 2),
    );
    await writeFile(join(work, ".intentic/config/settings.json"), JSON.stringify({ workspaceMap: true }, null, 2));
    await writeFile(
        join(work, ".intentic/config/capabilities.json"),
        JSON.stringify([{ id: "remote-only", kind: "mcp", config: { url: "https://example.com/mcp" } }], null, 2),
    );
    await mkdir(join(work, ".intentic/config/workspace-extensions/hello"), { recursive: true });
    await writeFile(
        join(work, ".intentic/config/workspace-extensions/hello/intentic-extension.json"),
        JSON.stringify({ publisher: "acme", name: "hello", version: "1.0.0", engines: { intentic: "^0.2.0" } }),
    );
    await writeFile(join(work, ".intentic/config/environment.custom.Dockerfile"), "RUN apt-get install -y ffmpeg\n");
    await mutate?.(work);
    await defaultGit(work, ["add", "-A"]);
    await defaultGit(work, [...AUTHOR, "commit", "-q", "-m", "workspace"]);
    await defaultGit(work, ["remote", "add", "origin", bare]);
    await defaultGit(work, ["push", "-q", "-u", "origin", "main"]);
    return bare;
};

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
    expect(await readFile(join(target.work, ".intentic/config/environment.d/definition.Dockerfile"), "utf8")).toBe("RUN apt-get install -y ffmpeg\n");
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

/* ---- the workspace repo: the section that carries a sandbox's own way of working ---- */

const workspaceToml = (remote: string, ref?: string): string =>
    [
        "schemaVersion = 1",
        "",
        "[workspace]",
        `remote = ${JSON.stringify(remote)}`,
        ...(ref === undefined ? [] : [`ref = ${JSON.stringify(ref)}`]),
        "",
    ].join("\n");

test("the workspace travels by reference: its content arrives, and everything in it that acts by itself arrives off", async () => {
    const remote = await publishedWorkspace();

    const target = await makeRoots();
    await makeWorkspaceRepo(target.work);
    const targetServices = servicesFor(target, {
        automations: fileAutomationsStore(
            join(target.work, ".intentic/config/automations.json"),
            join(target.work, ".intentic/records/automation-runs.json"),
        ),
        sandboxSettings: { get: async () => SandboxSettingsSchema.parse({}) },
        secretRegistry: async () => [],
    });
    const definitions = createDefinitions(targetServices);

    const plan = await definitions.plan(workspaceToml(remote, "main"));
    expect(plan.items.map((item) => [item.id, item.applicable])).toEqual([["workspace", true]]);
    // Said before anything is fetched, because at preview time nobody can know WHICH things the tree carries.
    expect(plan.needsAction.map((action) => action.subject)).toEqual(["What the workspace brings arrives switched off"]);

    const report = await definitions.apply({ token: plan.token, items: ["workspace"] });
    expect(report.failed).toEqual([]);

    // The sandbox's own content, the half no definition could carry before this section existed.
    expect(await readFile(join(target.work, "notes.md"), "utf8")).toBe("workspace notes\n");
    expect(existsSync(join(target.work, ".intentic/config/skills/mine/SKILL.md"))).toBe(true);
    // These files have typed checklist sections of their own. Selecting only the workspace cannot smuggle
    // their remote copies around those checkboxes.
    expect(existsSync(join(target.work, ".intentic/config/settings.json"))).toBe(false);
    expect(existsSync(join(target.work, ".intentic/config/capabilities.json"))).toBe(false);

    // The automation the tree carried is OFF: the scheduler fires enabled ones unattended.
    expect((await targetServices.automations.list()).map((automation) => [automation.id, automation.enabled])).toEqual([["nightly", false]]);
    // The workspace extension is OFF: an absent entry means enabled, so arriving quietly is arriving on.
    expect(JSON.parse(await readFile(join(target.work, ".intentic/config/extension-enablement.json"), "utf8"))).toEqual({ "acme.hello": false });
    // The overlay went to the approval gate rather than arriving pre-approved.
    expect(existsSync(join(target.work, ".intentic/config/environment.custom.Dockerfile"))).toBe(false);
    expect(await readFile(join(target.work, ".intentic/config/environment.d/workspace.Dockerfile"), "utf8")).toBe("RUN apt-get install -y ffmpeg\n");
    expect(report.needsAction.map((action) => action.subject)).toEqual([
        "What the workspace brings arrives switched off",
        "Approve and rebuild the environment",
        "Turn on the automations you want",
        "Enable the workspace extensions you trust",
    ]);

    // And a definition derived HERE now names the same remote, which is what makes drift a real comparison.
    const { definition, omitted } = await deriveDefinition(targetServices);
    expect(definition.workspace).toEqual({ remote, ref: "main" });
    expect(omitted).toEqual([]);
    await cleanup();
});

test("an unpublished workspace is named as the export's first omission, with what publishing would buy", async () => {
    const source = await makeRoots();
    await makeWorkspaceRepo(source.work);
    const { definition, omitted } = await deriveDefinition(
        servicesFor(source, { sandboxSettings: { get: async () => SandboxSettingsSchema.parse({}) }, secretRegistry: async () => [] }),
    );
    expect(definition.workspace).toBeUndefined();
    expect(omitted[0]?.subject?.toLowerCase()).toContain("workspace");
    expect(omitted[0]?.detail?.length).toBeGreaterThan(0);
    await cleanup();
});

test("a workspace with a history of its own, or one already published, is never taken over", async () => {
    const remote = await publishedWorkspace();

    // Two commits: somebody has worked here, so this is no longer a fresh sandbox.
    const worked = await makeRoots();
    await makeWorkspaceRepo(worked.work, 2);
    const workedPlan = await createDefinitions(servicesFor(worked)).plan(workspaceToml(remote));
    expect(workedPlan.items[0]?.applicable).toBe(false);
    expect(workedPlan.items[0]?.reason?.length).toBeGreaterThan(0);

    // Already published: this workspace is somebody's clone already, and a definition lands beside, never over.
    const published = await makeRoots();
    await makeWorkspaceRepo(published.work);
    await defaultGit(published.work, ["remote", "add", "origin", remote]);
    const publishedPlan = await createDefinitions(servicesFor(published)).plan(workspaceToml(remote));
    expect(publishedPlan.items[0]?.applicable).toBe(false);
    expect(publishedPlan.items[0]?.reason).not.toBe(workedPlan.items[0]?.reason);
    await cleanup();
});

test("one commit is not provenance: only the daemon-marked baseline is pristine", async () => {
    const remote = await publishedWorkspace();

    const unmarked = await makeRoots();
    await makeWorkspaceRepo(unmarked.work);
    await defaultGit(unmarked.work, ["config", "--unset-all", ROOT_BASELINE_CONFIG]);
    const unmarkedPlan = await createDefinitions(servicesFor(unmarked)).plan(workspaceToml(remote));
    expect(unmarkedPlan.items[0]?.applicable).toBe(false);

    const dirty = await makeRoots();
    await makeWorkspaceRepo(dirty.work);
    await writeFile(join(dirty.work, "notes.md"), "mine\n");
    const dirtyPlan = await createDefinitions(servicesFor(dirty)).plan(workspaceToml(remote));
    expect(dirtyPlan.items[0]?.applicable).toBe(false);

    const baseline = await makeRoots();
    await makeWorkspaceRepo(baseline.work);
    const baselinePlan = await createDefinitions(servicesFor(baseline)).plan(workspaceToml(remote));
    expect(baselinePlan.items[0]?.applicable).toBe(true);

    const unborn = await makeRoots();
    await defaultGit(unborn.work, ["init", "-b", "main"]);
    const unmarkedUnborn = await createDefinitions(servicesFor(unborn)).plan(workspaceToml(remote));
    expect(unmarkedUnborn.items[0]?.applicable).toBe(false);
    await defaultGit(unborn.work, ["config", ROOT_FRESH_CONFIG, "true"]);
    const markedUnborn = await createDefinitions(servicesFor(unborn)).plan(workspaceToml(remote));
    expect(markedUnborn.items[0]?.applicable).toBe(true);
    await cleanup();
});

test("workspace selection preserves the target files owned by unticked definition sections", async () => {
    const remote = await publishedWorkspace();
    const target = await makeRoots();
    await mkdir(join(target.work, ".intentic/config"), { recursive: true });
    const settings = '{"workspaceMap":false}\n';
    const capabilities = '[{"id":"mine","kind":"mcp","config":{"url":"https://mine.example/mcp"}}]\n';
    const overlay = "RUN echo target-approved\n";
    await writeFile(join(target.work, ".intentic/config/settings.json"), settings);
    await writeFile(join(target.work, ".intentic/config/capabilities.json"), capabilities);
    await writeFile(join(target.work, ".intentic/config/environment.custom.Dockerfile"), overlay);
    await makeWorkspaceRepo(target.work);

    const definitions = createDefinitions(
        servicesFor(target, {
            sandboxSettings: { get: async () => SandboxSettingsSchema.parse({}) },
            secretRegistry: async () => [],
        }),
    );
    const plan = await definitions.plan(workspaceToml(remote, "main"));
    const report = await definitions.apply({ token: plan.token, items: ["workspace"] });

    expect(report.failed).toEqual([]);
    expect(await readFile(join(target.work, ".intentic/config/settings.json"), "utf8")).toBe(settings);
    expect(await readFile(join(target.work, ".intentic/config/capabilities.json"), "utf8")).toBe(capabilities);
    expect(await readFile(join(target.work, ".intentic/config/environment.custom.Dockerfile"), "utf8")).toBe(overlay);
    // The source workspace's overlay is still untrusted; because its own checklist item was unticked, the
    // workspace half can only carry it as a proposal.
    expect(await readFile(join(target.work, ".intentic/config/environment.d/workspace.Dockerfile"), "utf8")).toBe("RUN apt-get install -y ffmpeg\n");
    await cleanup();
});

test("private ignored state in a remote is refused before checkout and the target secret is untouched", async () => {
    const remote = await publishedWorkspace(async (work) => {
        await mkdir(join(work, ".intentic/secrets/auth"), { recursive: true });
        await writeFile(join(work, ".intentic/secrets/auth/token.json"), '{"token":"foreign"}\n');
    });
    const target = await makeRoots();
    await makeWorkspaceRepo(target.work);
    await mkdir(join(target.work, ".intentic/secrets/auth"), { recursive: true });
    await writeFile(join(target.work, ".intentic/secrets/auth/token.json"), '{"token":"mine"}\n');

    const definitions = createDefinitions(servicesFor(target));
    const plan = await definitions.plan(workspaceToml(remote, "main"));
    expect(plan.items[0]?.applicable).toBe(true); // the private file is ignored, so the marked baseline stays clean
    const report = await definitions.apply({ token: plan.token, items: ["workspace"] });

    expect(report.applied).toEqual([]);
    expect(report.failed[0]?.error).toContain(".intentic/secrets/auth/token.json");
    expect(await readFile(join(target.work, ".intentic/secrets/auth/token.json"), "utf8")).toBe('{"token":"mine"}\n');
    expect(await workspaceRemoteUrl(target.work)).toBeUndefined();
    await cleanup();
});

test("symlinks and unreadable active manifests fail closed before the workspace lands", async () => {
    const linkedRemote = await publishedWorkspace(async (work) => {
        await symlink("notes.md", join(work, "linked-notes.md"));
    });
    const linkedTarget = await makeRoots();
    await makeWorkspaceRepo(linkedTarget.work);
    const linkedDefinitions = createDefinitions(servicesFor(linkedTarget));
    const linkedPlan = await linkedDefinitions.plan(workspaceToml(linkedRemote, "main"));
    const linkedReport = await linkedDefinitions.apply({ token: linkedPlan.token, items: ["workspace"] });
    expect(linkedReport.failed[0]?.error).toContain("120000");
    expect(existsSync(join(linkedTarget.work, "notes.md"))).toBe(false);

    const brokenRemote = await publishedWorkspace(async (work) => {
        await writeFile(join(work, ".intentic/config/automations.json"), "not json\n");
    });
    const brokenTarget = await makeRoots();
    await makeWorkspaceRepo(brokenTarget.work);
    const brokenDefinitions = createDefinitions(servicesFor(brokenTarget));
    const brokenPlan = await brokenDefinitions.plan(workspaceToml(brokenRemote, "main"));
    const brokenReport = await brokenDefinitions.apply({ token: brokenPlan.token, items: ["workspace"] });
    expect(brokenReport.failed[0]?.error).toContain("automations.json");
    expect(existsSync(join(brokenTarget.work, "notes.md"))).toBe(false);
    expect(await workspaceRemoteUrl(brokenTarget.work)).toBeUndefined();
    await cleanup();
});
