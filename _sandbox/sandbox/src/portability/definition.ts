import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import {
    type Capability,
    CapabilitySchema,
    type NeedsAction,
    type DefinitionRepository,
    type DefinitionWorkspace,
    type SandboxDefinition,
    SandboxDefinitionSchema,
    SandboxSettingsSchema,
} from "@intentic/sandbox-contract";
import { defaultGit } from "@intentic/scaffold";
import { parse } from "smol-toml";
import { ArrivalFormatError } from "../arrival-error.js";
import type { Services } from "../composition.js";
import { baseImageOf, customPath } from "../environment/environment.js";
import { remoteState } from "../git/remote/remote.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";
import { stateRelPath } from "../workspace/layout/state-paths.js";

// Derives a sandbox's declarable shape from its live manifests, emits it as sandbox.toml, and parses it back for
// apply/diff (apply-definition.ts writes it). Never stored: every export reads the same stores the sandbox runs on.
// Emission is hand-rolled TOML for byte-identical, commented output; parsing is smol-toml plus the contract schema.

// Filename used wherever this lands: a download, a repo, the boot-seed description.
export const DEFINITION_FILE = "sandbox.toml";

export class DefinitionFormatError extends ArrivalFormatError {}

// Every versioned .intentic/config/ entry appears in exactly one of DEFINITION_SOURCES or DEFINITION_WORKSPACE, checked
// against WORKSPACE_STATE_FILES by definition-coverage.test.ts. A source travels as a typed document section through a
// native write path; everything else rides the workspace repo as the file it already is.

// Each entry sources one document section and wins over whatever the workspace checkout delivered for it.
export const DEFINITION_SOURCES: readonly string[] = [
    ".intentic/config/capabilities.json",
    ".intentic/config/environment.custom.Dockerfile",
    ".intentic/config/settings.json",
];

// Manifests riding the workspace repo, not a section; a workspaceless definition omits them all.
export const DEFINITION_WORKSPACE: readonly { readonly path: string; readonly note: string }[] = [
    {
        path: ".intentic/config/personas.json",
        note: "Personas arrive naming accounts the target has not connected; each reads as broken until its capability is.",
    },
    { path: ".intentic/config/personas/", note: "Persona prompt files, beside the cards that name them." },
    {
        // Via stateRelPath so the state union type checks this name; the trailing slash is re-added after trimming.
        path: `${stateRelPath(".intentic/config/hooks/")}/`,
        note: "The scripts a file.edited rule runs, beside the settings that name them; one that finds nothing it recognises on the target stays silent rather than failing every edit.",
    },
    { path: ".intentic/config/approvals/", note: "Approvals arrive awaiting a yes, which is the only state they act in." },
    {
        path: ".intentic/config/automations.json",
        note: "Arrive DISABLED: the scheduler fires enabled automations, and nobody consented to a stranger's schedule. A webhook or intake mints a fresh credential here; the old URL stays behind with the source.",
    },
    {
        path: ".intentic/config/workflows.json",
        note: "Workflow designs are inert until someone runs one. A release gate mints a fresh token here; the URL its pipelines were taught stays behind with the source.",
    },
    { path: ".intentic/config/loop-designs.json", note: "Loop designs are inert until someone runs one." },
    { path: ".intentic/config/extension-settings.json", note: "Per-extension settings, beside the extensions they configure." },
    {
        path: ".intentic/config/extension-enablement.json",
        note: "Rewritten on arrival so every workspace extension lands OFF: absent means enabled, and extension code runs.",
    },
    { path: ".intentic/config/extension-update-policy.json", note: "Update policy, beside the extensions it governs." },
    {
        path: ".intentic/config/engines.json",
        note: "Where each agent engine takes its version from. A pin arrives naming a version the target has to download before it can honour it; until then that engine runs the target image's own copy.",
    },
    {
        path: ".intentic/config/workspace-extensions/",
        note: "Extension code, authored here. It arrives switched off; the owner enables what they trust.",
    },
    { path: ".intentic/config/templates.json", note: "Scaffold template choices; they point at repos the definition's own sections name." },
    {
        // Via the state table's type so a row added after the rule lands is checked against WORKSPACE_STATE_FILES.
        path: stateRelPath(".intentic/config/autostart.json"),
        note: "Which apps the daemon starts at boot, by repo and app folder; an entry whose folder the target lacks is one skipped log line per boot, nothing more.",
    },
    { path: ".intentic/config/skills/", note: "Locally-authored skills. Which skills are ON is a setting; the files are these." },
    {
        path: ".intentic/config/capability-dismissals.json",
        note: "Suggestions this workspace turned down. Carried as-is; the target can undismiss any of them.",
    },
    {
        path: ".intentic/config/environment.Dockerfile",
        note: "A pending proposal arrives as a proposal: a question at the target owner's approval gate, never a build.",
    },
    { path: ".intentic/config/environment.d/", note: "Agent overlay drafts, composed into that same proposal." },
    {
        path: ".intentic/config/heavy-commands.json",
        note: "Learned from this workspace's runs; harmless where it is wrong, and relearned against the target's repos.",
    },
    // A prose policy read by a model, not parsed; rides the workspace so it only arrives via an owner's clone.
    {
        // Via the state table's type; a compiler-checked path cannot drift from WORKSPACE_STATE_FILES.
        path: stateRelPath(".intentic/config/safety.md"),
        note: "Arrives as the file it is, and governs the target from its first turn: read what it says before cloning a workspace you did not write.",
    },
];

// Sweeps vaults before manifests are read, so a hand-written secret cannot ride out in a definition; best-effort, never
// fails the export.
const sweptOut = async (run: () => Promise<readonly string[]>): Promise<void> => {
    try {
        await run();
    } catch {
        // Silent; the classification of what's read next is the second line of defense.
    }
};

// The remote a checkout can be referenced by, or why not; a broken git dir reports unreferenceable rather than failing.
// Shared by repos and the workspace, which differ only in how the refusal reads.
type Unreferenceable = { readonly problem: "none" | "unreadable"; readonly remoteName?: string };
const referenceOf = async (dir: string): Promise<{ remote: string; ref?: string } | Unreferenceable> => {
    const state = await remoteState(dir).catch(() => ({ ahead: 0, behind: 0 }) as Awaited<ReturnType<typeof remoteState>>);
    if (state.remote === undefined) {
        return { problem: "none" };
    }
    const url = (await defaultGit(dir, ["remote", "get-url", state.remote]).catch(() => undefined))?.stdout.trim();
    if (url === undefined || url === "") {
        return { problem: "unreadable", remoteName: state.remote };
    }
    return { remote: url, ...(state.branch !== undefined && state.branch !== "" ? { ref: state.branch } : {}) };
};

const unreferenceable = (found: { remote: string; ref?: string } | Unreferenceable): found is Unreferenceable => "problem" in found;

// One repo as a reference, or the reason it cannot be one.
const repositoryOf = async (root: string, id: string): Promise<{ repo?: DefinitionRepository; omitted?: NeedsAction }> => {
    const found = await referenceOf(join(root, id));
    if (!unreferenceable(found)) {
        return { repo: { id, ...found } };
    }
    return {
        omitted: {
            subject: `Repository ${id}`,
            detail:
                found.problem === "none"
                    ? "No remote configured, so a definition has nothing a target could clone. Push it somewhere first, or move it with a bundle."
                    : `Its "${found.remoteName}" remote has no URL this daemon can read; fix the remote or move it with a bundle.`,
        },
    };
};

// Refusal here is how an owner discovers the [workspace] feature: unpublished /work reads what publishing would buy and
// what's missing without it.
const workspaceOf = async (root: string): Promise<{ workspace?: DefinitionWorkspace; omitted?: NeedsAction }> => {
    const found = await referenceOf(root);
    if (!unreferenceable(found)) {
        return { workspace: found };
    }
    return {
        omitted: {
            subject: "The workspace itself",
            detail:
                found.problem === "none"
                    ? "/work has no remote, so this definition carries none of the workspace's own content: notes, skills, personas, automations, workflow and loop designs, approvals, workspace extensions. Publish the workspace to add a [workspace] section, or move it with a bundle."
                    : `The workspace's "${found.remoteName}" remote has no URL this daemon can read; fix it, or move the workspace with a bundle.`,
        },
    };
};

const canon = (value: unknown): string => JSON.stringify(value) ?? "null";

// Only settings differing from schema defaults; an unmentioned flag keeps the target's own default.
const settledSettings = (current: Record<string, unknown>): Record<string, unknown> => {
    const defaults = SandboxSettingsSchema.parse({}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(current).filter(([key, value]) => canon(value) !== canon(defaults[key])));
};

// Derives the definition from live stores, plus omitted: what could not be expressed, as lines the owner can act on.
export const deriveDefinition = async (services: Services): Promise<{ definition: SandboxDefinition; omitted: NeedsAction[] }> => {
    await Promise.all([sweptOut(() => services.vaultManifestSecrets()), sweptOut(() => services.vaultExtensionSettingSecrets())]);
    const omitted: NeedsAction[] = [];
    // Read first: this section decides whether the sandbox's own content travels at all.
    const { workspace, omitted: workspaceSkip } = await workspaceOf(services.workspace.root);
    if (workspaceSkip !== undefined) {
        omitted.push(workspaceSkip);
    }
    const repositories: DefinitionRepository[] = [];
    for (const id of await discoverRepos(services.workspace.root)) {
        const { repo, omitted: skip } = await repositoryOf(services.workspace.root, id);
        if (repo !== undefined) {
            repositories.push(repo);
        }
        if (skip !== undefined) {
            omitted.push(skip);
        }
    }
    const custom = ((await services.files.read(customPath(services))) ?? "").trim();
    // Each entry is validated on its own; one bad row costs just its line, never the whole export.
    const capabilities: Capability[] = [];
    for (const entry of (await services.capabilities.list()).toSorted((left, right) => left.id.localeCompare(right.id))) {
        const parsed = CapabilitySchema.safeParse(entry);
        if (parsed.success) {
            capabilities.push(parsed.data);
        } else {
            omitted.push({
                subject: `Connection ${entry.id}`,
                detail: "Its manifest entry does not parse as a capability this daemon knows, so it cannot travel by reference; re-add it on the Capabilities view.",
            });
        }
    }
    const secrets = [...new Set((await services.secretRegistry()).map((secret) => secret.name))].toSorted();
    const settings = settledSettings((await services.sandboxSettings.get()) as unknown as Record<string, unknown>);
    const name = services.config.sandbox.name;
    return {
        definition: SandboxDefinitionSchema.parse({
            schemaVersion: 1,
            ...(name === "" ? {} : { name }),
            environment: {
                baseImage: baseImageOf(services.config.sandbox.baseImage, services.config.sandbox.image),
                ...(custom === "" ? {} : { dockerfile: `${custom}\n` }),
            },
            ...(workspace === undefined ? {} : { workspace }),
            repositories,
            capabilities,
            secrets,
            settings,
        }),
        omitted,
    };
};

// The settings-only definition a runner declares: capabilities and secrets never travel to it; repos are a git mirror,
// not clones. Shared by the hello, drift lines, and sync push, so all three agree.
export const settingsDefinition = async (services: Services): Promise<SandboxDefinition> =>
    SandboxDefinitionSchema.parse({
        schemaVersion: 1,
        environment: {},
        repositories: [],
        capabilities: [],
        secrets: [],
        settings: settledSettings((await services.sandboxSettings.get()) as unknown as Record<string, unknown>),
    });

// One line per settings key differing between a runner and its parent; separate from definitionDiff only for wording
// (parent/runner, not upload). A key absent on either side runs the default.
export const settingsDrift = (parent: SandboxDefinition, runner: SandboxDefinition): NeedsAction[] => {
    const defaults = SandboxSettingsSchema.parse({}) as Record<string, unknown>;
    const parentSettings = parent.settings as Record<string, unknown>;
    const runnerSettings = runner.settings as Record<string, unknown>;
    const differences: NeedsAction[] = [];
    for (const key of [...new Set([...Object.keys(parentSettings), ...Object.keys(runnerSettings)])].toSorted()) {
        const here = parentSettings[key] ?? defaults[key];
        const there = runnerSettings[key] ?? defaults[key];
        if (canon(here) !== canon(there)) {
            differences.push({ subject: `Setting ${key}`, detail: `This sandbox runs ${shortValue(here)}; the runner has ${shortValue(there)}.` });
        }
    }
    return differences;
};

// Hand-rolled TOML, not a library stringify: byte-identical output (fixed order, sorted keys) plus comment lines.
// Handles only what the schema can hold (strings, numbers, booleans, arrays, plain objects, one Dockerfile literal);
// anything else throws rather than emitting a file that will not parse back.

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const tomlKey = (name: string): string => (BARE_KEY.test(name) ? name : JSON.stringify(name));

// JSON string escaping is a strict subset of TOML basic-string escaping.
const tomlValue = (value: unknown): string => {
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    if (Array.isArray(value)) {
        return `[${value.map(tomlValue).join(", ")}]`;
    }
    if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${tomlKey(key)} = ${tomlValue(entry)}`);
        return `{ ${entries.join(", ")} }`;
    }
    throw new DefinitionFormatError(`a definition cannot express a ${value === null ? "null" : typeof value} value`);
};

// Multi-line literal so backslashes and quotes read as written; falls back to an escaped string only when the value
// contains '''.
const tomlBlock = (value: string): string => {
    // A literal block trims its opening newline but keeps the closing one; a value lacking one would gain a byte.
    if (!value.endsWith("\n")) {
        return JSON.stringify(value);
    }
    // eslint-disable-next-line no-control-regex
    if (value.includes("'''") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || value.includes("\r")) {
        return JSON.stringify(value);
    }
    return `'''\n${value}'''`;
};

// The emitted file is the reader's to commit and hand-edit elsewhere; nothing here writes back, so no copy needs a
// managed-file header.
export const emitDefinitionToml = (definition: SandboxDefinition, omitted: readonly NeedsAction[] = []): string => {
    const lines: string[] = [
        "# Intentic sandbox definition: the declarable shape of a sandbox, safe to publish.",
        "# Apply it to an empty sandbox from the Environment tab. Secret NAMES travel, values never do;",
        "# the overlay below lands as a proposal for the target owner's approval, it never builds unreviewed.",
        `schemaVersion = ${definition.schemaVersion}`,
    ];
    if (definition.name !== undefined) {
        lines.push(`name = ${tomlValue(definition.name)}`);
    }
    if (definition.secrets.length > 0) {
        lines.push("", "# What the target will ask its owner to provide, by name.", `secrets = ${tomlValue(definition.secrets)}`);
    }
    const environment = definition.environment;
    if (environment.baseImage !== undefined || environment.dockerfile !== undefined) {
        lines.push("", "[environment]");
        if (environment.baseImage !== undefined) {
            lines.push(`baseImage = ${tomlValue(environment.baseImage)}`);
        }
        if (environment.dockerfile !== undefined) {
            lines.push(`dockerfile = ${tomlBlock(environment.dockerfile)}`);
        }
    }
    const settings = Object.entries(definition.settings)
        .filter(([, value]) => value !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right));
    if (settings.length > 0) {
        lines.push("", "# Only the agent settings that differ from their defaults.", "[settings]");
        for (const [key, value] of settings) {
            lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
        }
    }
    const workspace = definition.workspace;
    if (workspace !== undefined) {
        lines.push(
            "",
            "# The workspace repo itself: this sandbox's own content — notes, skills, personas, automations,",
            "# designs, approvals, workspace extensions. Applied before the repositories below, and never over",
            "# a workspace that already has a history of its own.",
            "[workspace]",
            `remote = ${tomlValue(workspace.remote)}`,
        );
        if (workspace.ref !== undefined) {
            lines.push(`ref = ${tomlValue(workspace.ref)}`);
        }
    }
    for (const repo of definition.repositories) {
        lines.push("", "[[repositories]]", `id = ${tomlValue(repo.id)}`, `remote = ${tomlValue(repo.remote)}`);
        if (repo.ref !== undefined) {
            lines.push(`ref = ${tomlValue(repo.ref)}`);
        }
    }
    if (definition.capabilities.length > 0) {
        lines.push("", "# Connections by shape: each lands unauthenticated, waiting for one credential apiece.");
        for (const capability of definition.capabilities) {
            lines.push(
                "[[capabilities]]",
                `id = ${tomlValue(capability.id)}`,
                `kind = ${tomlValue(capability.kind)}`,
                `config = ${tomlValue(capability.config)}`,
                "",
            );
        }
        while (lines.at(-1) === "") {
            lines.pop();
        }
    }
    if (omitted.length > 0) {
        lines.push("", "# Left out of this export, each for a stated reason:");
        for (const entry of omitted) {
            lines.push(`#   ${entry.subject}: ${entry.detail}`);
        }
    }
    return `${lines.join("\n")}\n`;
};

// Strict TOML, then the contract schema; each failure is named.

const recordLike = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Compares only keys the input supplied: schema defaults added during parsing are harmless, but any key TOML held and
// parsing dropped is named, unlike a JSON API schema that tolerates an unknown newer field.
const strippedDefinitionKeys = (raw: unknown, parsed: unknown, path = ""): string[] => {
    if (Array.isArray(raw) && Array.isArray(parsed)) {
        return raw.flatMap((entry, index) => strippedDefinitionKeys(entry, parsed[index], `${path}[${index}]`));
    }
    if (!recordLike(raw) || !recordLike(parsed)) {
        return [];
    }
    return Object.entries(raw).flatMap(([key, value]) => {
        const nested = path === "" ? key : `${path}.${key}`;
        if (!Object.hasOwn(parsed, key)) {
            return [nested];
        }
        return strippedDefinitionKeys(value, parsed[key], nested);
    });
};

export const parseDefinitionToml = (text: string): SandboxDefinition => {
    let raw: unknown;
    try {
        raw = parse(text);
    } catch (error) {
        throw new DefinitionFormatError(`this is not readable as TOML: ${errorMessage(error)}`);
    }
    const parsed = SandboxDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
        const problems = parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") === "" ? "document" : issue.path.join(".")}: ${issue.message}`)
            .join("; ");
        throw new DefinitionFormatError(`this is TOML but not a sandbox definition: ${problems}`);
    }
    const stripped = strippedDefinitionKeys(raw, parsed.data);
    if (stripped.length > 0) {
        throw new DefinitionFormatError(
            `this is TOML but not a sandbox definition: unknown field${stripped.length === 1 ? "" : "s"} ${stripped.join(", ")}`,
        );
    }
    return parsed.data;
};

// One line per difference between a definition and this sandbox's derived one; pure over two definitions. Settings
// compare through schema defaults, so a flag absent on either side runs the default, never reading as drift.

const shortValue = (value: unknown): string => {
    const spelled = canon(value);
    return spelled.length > 60 ? `${spelled.slice(0, 57)}…` : spelled;
};

const trimmed = (value: string | undefined): string => (value ?? "").trim();

// Shared spelling for a checkout reference; repository and workspace lines both format through this.
const reference = (found: { readonly remote: string; readonly ref?: string | undefined }): string =>
    `${found.remote}${found.ref === undefined ? "" : ` @ ${found.ref}`}`;

export const definitionDiff = (current: SandboxDefinition, target: SandboxDefinition): NeedsAction[] => {
    const differences: NeedsAction[] = [];
    if (trimmed(target.environment.dockerfile) !== trimmed(current.environment.dockerfile)) {
        differences.push({
            subject: "Environment overlay",
            detail:
                trimmed(target.environment.dockerfile) === ""
                    ? "The definition has no overlay section; this sandbox has one."
                    : trimmed(current.environment.dockerfile) === ""
                      ? "The definition carries an overlay section; this sandbox has none."
                      : "The overlay section differs from the definition's.",
        });
    }
    // Checked first: an absent [workspace] against a published one is real drift, not agreement by omission.
    const hereWorkspace = current.workspace;
    const thereWorkspace = target.workspace;
    if (hereWorkspace !== undefined && thereWorkspace === undefined) {
        differences.push({ subject: "Workspace", detail: `This workspace is published at ${reference(hereWorkspace)}; the definition names none.` });
    } else if (hereWorkspace === undefined && thereWorkspace !== undefined) {
        differences.push({ subject: "Workspace", detail: `The definition names ${reference(thereWorkspace)}; this workspace has no remote.` });
    } else if (
        hereWorkspace !== undefined &&
        thereWorkspace !== undefined &&
        (hereWorkspace.remote !== thereWorkspace.remote || trimmed(hereWorkspace.ref) !== trimmed(thereWorkspace.ref))
    ) {
        differences.push({
            subject: "Workspace",
            detail: `The definition says ${reference(thereWorkspace)}; this workspace is at ${reference(hereWorkspace)}.`,
        });
    }
    const currentRepos = new Map(current.repositories.map((repo) => [repo.id, repo]));
    const targetRepos = new Map(target.repositories.map((repo) => [repo.id, repo]));
    for (const [id, repo] of targetRepos) {
        const here = currentRepos.get(id);
        if (here === undefined) {
            differences.push({ subject: `Repository ${id}`, detail: `In the definition (${repo.remote}), not in this workspace.` });
        } else if (here.remote !== repo.remote || trimmed(here.ref) !== trimmed(repo.ref)) {
            differences.push({
                subject: `Repository ${id}`,
                detail: `The definition says ${repo.remote}${repo.ref === undefined ? "" : ` @ ${repo.ref}`}; this workspace has ${here.remote}${here.ref === undefined ? "" : ` @ ${here.ref}`}.`,
            });
        }
    }
    for (const id of currentRepos.keys()) {
        if (!targetRepos.has(id)) {
            differences.push({ subject: `Repository ${id}`, detail: "In this workspace, not in the definition." });
        }
    }
    const currentCapabilities = new Map(current.capabilities.map((capability) => [capability.id, capability]));
    const targetCapabilities = new Map(target.capabilities.map((capability) => [capability.id, capability]));
    for (const [id, capability] of targetCapabilities) {
        const here = currentCapabilities.get(id);
        if (here === undefined) {
            differences.push({ subject: `Connection ${id}`, detail: `In the definition (${capability.kind}), not connected here.` });
        } else if (here.kind !== capability.kind || canon(here.config) !== canon(capability.config)) {
            differences.push({ subject: `Connection ${id}`, detail: "Configured differently here than in the definition." });
        }
    }
    for (const id of currentCapabilities.keys()) {
        if (!targetCapabilities.has(id)) {
            differences.push({ subject: `Connection ${id}`, detail: "Connected here, not in the definition." });
        }
    }
    const defaults = SandboxSettingsSchema.parse({}) as Record<string, unknown>;
    const currentSettings = current.settings as Record<string, unknown>;
    const targetSettings = target.settings as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(currentSettings), ...Object.keys(targetSettings)])].toSorted()) {
        const here = currentSettings[key] ?? defaults[key];
        const there = targetSettings[key] ?? defaults[key];
        if (canon(here) !== canon(there)) {
            differences.push({
                subject: `Setting ${key}`,
                detail: `The definition says ${shortValue(there)}; this sandbox has ${shortValue(here)}.`,
            });
        }
    }
    const currentSecrets = new Set(current.secrets);
    for (const name of target.secrets) {
        if (!currentSecrets.has(name)) {
            differences.push({ subject: `Secret ${name}`, detail: "Named in the definition, no value stored here." });
        }
    }
    return differences;
};
