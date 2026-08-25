import { join } from "node:path";
import {
    type Capability,
    CapabilitySchema,
    type DefinitionAction,
    type DefinitionRepository,
    type SandboxDefinition,
    SandboxDefinitionSchema,
    SandboxSettingsSchema,
} from "@intentic/sandbox-contract";
import { defaultGit } from "@intentic/scaffold";
import { parse } from "smol-toml";
import type { Services } from "../composition.js";
import { baseImageOf, customPath } from "../environment/environment.js";
import { remoteState } from "../git/remote.js";
import { discoverRepos } from "../workspace/repo-discovery.js";

/* THE DEFINITION SIDE OF PORTABILITY: a sandbox's declarable shape derived from its live manifests, emitted
 * as `sandbox.toml`, and read back for apply/diff (apply-definition.ts drives the writes).
 *
 * DERIVED, NEVER STORED. There is no definition file the daemon keeps in sync; every export walks the same
 * stores the product itself runs on (the capability manifest, the settings store, the custom overlay file, the
 * repos' own git config), so the emitted document cannot disagree with the sandbox it describes. That is also
 * what makes drift (definitionDiff) a computation instead of a bookkeeping duty.
 *
 * TOML, hand-rolled on the way OUT and library-parsed on the way IN. The emitter is ~80 lines of this file
 * because determinism and comments are the point: a definition is reviewed, diffed and committed, so two
 * exports of the same sandbox must be byte-identical and the file must explain itself. Parsing is smol-toml,
 * a strict TOML 1.0 reader, followed by the contract schema, so a hand-edited file fails with a message
 * naming the field rather than half-applying.
 */

// What the emitted file is called wherever one lands (downloads, a repo, the boot seed's description).
export const DEFINITION_FILE = "sandbox.toml";

export class DefinitionFormatError extends Error {}

/* ---- the coverage lists: every versioned config manifest is placed, or the guard fails ----
 *
 * definition-coverage.test.ts holds these against WORKSPACE_STATE_FILES: every `.intentic/config/` entry
 * marked `versioned` must appear in exactly one of the two lists below. Adding a config surface to the daemon
 * therefore forces the question this module exists to ask, "is this declarable, or is it content only a
 * bundle can move?", the same discipline the portability classes enforce one level down. */

// The manifests deriveDefinition reads. Each is a source of one section of the emitted document.
export const DEFINITION_SOURCES: readonly string[] = [
    ".intentic/config/capabilities.json",
    ".intentic/config/environment.custom.Dockerfile",
    ".intentic/config/settings.json",
];

// The manifests a definition deliberately does NOT express, each with the reason a reader can act on. These
// are all `carry`: they move in a bundle, and the note says why a reference cannot stand in for them.
export const DEFINITION_EXCLUDED: readonly { readonly path: string; readonly note: string }[] = [
    { path: ".intentic/config/capability-dismissals.json", note: "Decisions about THIS workspace's suggestions; a template should not pre-dismiss the target's." },
    { path: ".intentic/config/personas.json", note: "A persona names connected accounts this sandbox holds; it travels with them, in a bundle." },
    { path: ".intentic/config/personas/", note: "Persona prompt files are authored content; they travel with their cards, in a bundle." },
    { path: ".intentic/config/environment.Dockerfile", note: "A pending proposal is a question to THIS owner; it is not part of the sandbox's settled shape." },
    { path: ".intentic/config/environment.d/", note: "Agent drafts awaiting review, same reason as the proposal they compose into." },
    { path: ".intentic/config/heavy-commands.json", note: "Learned from this workspace's own runs; the target relearns against its repos." },
    { path: ".intentic/config/drafts/", note: "Post drafts are authored content awaiting THIS owner's approval, bundle territory." },
    { path: ".intentic/config/automations.json", note: "Automations name channels, personas and repos of this sandbox; carried whole in a bundle rather than half-true by reference." },
    { path: ".intentic/config/workflows.json", note: "Workflow designs are authored content, bundle territory." },
    { path: ".intentic/config/loop-designs.json", note: "Loop designs are authored content, bundle territory." },
    { path: ".intentic/config/extension-settings.json", note: "Per-extension settings only mean something beside the extension state a bundle carries." },
    { path: ".intentic/config/extension-enablement.json", note: "The on/off switches ride the extension capabilities the definition already carries." },
    { path: ".intentic/config/workspace-extensions/", note: "Workspace extensions are code authored here; code travels in a bundle (or its own repo), never by reference in a definition." },
    { path: ".intentic/config/extension-update-policy.json", note: "Update policy rides the extension state a bundle carries." },
    { path: ".intentic/config/templates.json", note: "Scaffold template config points at this workspace's own source repo choices, bundle territory." },
    { path: ".intentic/config/skills/", note: "Locally-authored skills are content; the settings section carries which skills are ON, the files travel in a bundle." },
];

/* ---- derivation ---- */

// The bundle's own sweep discipline (bundle.ts says why): fill the vaults before reading the manifests, so a
// token an agent hand-wrote back into a config can never ride out inside a definition. Best-effort in both
// directions, a manifest the daemon cannot rewrite must not fail an export.
const sweptOut = async (run: () => Promise<readonly string[]>): Promise<void> => {
    try {
        await run();
    } catch {
        // Deliberately silent; the classification of what is read next is the second line of defense.
    }
};

// One repo as a reference, or the reason it cannot be one. Every git read is total: a repo whose git dir is
// broken (a dangling pointer mid-restore) reports as unportable rather than failing the export.
const repositoryOf = async (root: string, id: string): Promise<{ repo?: DefinitionRepository; omitted?: DefinitionAction }> => {
    const dir = join(root, id);
    const state = await remoteState(dir).catch(() => ({ ahead: 0, behind: 0 }) as Awaited<ReturnType<typeof remoteState>>);
    if (state.remote === undefined) {
        return {
            omitted: {
                subject: `Repository ${id}`,
                detail: "No remote configured, so a definition has nothing a target could clone. Push it somewhere first, or move it with a bundle.",
            },
        };
    }
    const url = (await defaultGit(dir, ["remote", "get-url", state.remote]).catch(() => undefined))?.stdout.trim();
    if (url === undefined || url === "") {
        return {
            omitted: {
                subject: `Repository ${id}`,
                detail: `Its "${state.remote}" remote has no URL this daemon can read; fix the remote or move it with a bundle.`,
            },
        };
    }
    return { repo: { id, remote: url, ...(state.branch !== undefined && state.branch !== "" ? { ref: state.branch } : {}) } };
};

const canon = (value: unknown): string => JSON.stringify(value) ?? "null";

// The settings that differ from their schema defaults, which is all a definition states: a flag it does not
// mention keeps the target's own default, so exporting the whole surface would freeze today's defaults into
// every future apply.
const settledSettings = (current: Record<string, unknown>): Record<string, unknown> => {
    const defaults = SandboxSettingsSchema.parse({}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(current).filter(([key, value]) => canon(value) !== canon(defaults[key])));
};

/* Derive the definition from the live stores, plus the list of what could not be expressed. The `omitted`
 * list is the definition's version of the bundle manifest's `excluded`: what turns "the export skipped
 * things" from a silence into lines the owner can act on. */
export const deriveDefinition = async (services: Services): Promise<{ definition: SandboxDefinition; omitted: DefinitionAction[] }> => {
    await Promise.all([sweptOut(() => services.vaultManifestSecrets()), sweptOut(() => services.vaultExtensionSettingSecrets())]);
    const omitted: DefinitionAction[] = [];
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
    // Each entry re-validated on its own, so one corrupt or hand-edited manifest row costs ITS line plus a
    // note, never the whole export: the same totality the repo reads above hold to.
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
            repositories,
            capabilities,
            secrets,
            settings,
        }),
        omitted,
    };
};

/* ---- the runner-scoped definition: settings only, the shape a runner declares and is held to ----
 *
 * Runners speak the definition format on three surfaces (the hello's parity claim, the parent's drift lines,
 * the sync push down the link), and on all three the document is a full SandboxDefinition whose only populated
 * section is settings: capabilities and secrets never travel to a runner, its repos are a git mirror rather
 * than clones with remotes, and its overlay parity rides the hash the run contract stamped. One helper, so the
 * three surfaces cannot disagree about what "a runner's definition" contains. */
export const settingsDefinition = async (services: Services): Promise<SandboxDefinition> =>
    SandboxDefinitionSchema.parse({
        schemaVersion: 1,
        environment: {},
        repositories: [],
        capabilities: [],
        secrets: [],
        settings: settledSettings((await services.sandboxSettings.get()) as unknown as Record<string, unknown>),
    });

/* Where a runner's settings stand against its parent's, one line per differing key. Pure, and separate from
 * definitionDiff for its wording alone: that surface speaks of "the definition" a person uploaded, while these
 * lines sit on a runner's card where the two sides are the parent and the runner. Same defaults rule — a key
 * absent on either side means that side runs the default, so omission never reads as drift against a default. */
export const settingsDrift = (parent: SandboxDefinition, runner: SandboxDefinition): DefinitionAction[] => {
    const defaults = SandboxSettingsSchema.parse({}) as Record<string, unknown>;
    const parentSettings = parent.settings as Record<string, unknown>;
    const runnerSettings = runner.settings as Record<string, unknown>;
    const differences: DefinitionAction[] = [];
    for (const key of [...new Set([...Object.keys(parentSettings), ...Object.keys(runnerSettings)])].toSorted()) {
        const here = parentSettings[key] ?? defaults[key];
        const there = runnerSettings[key] ?? defaults[key];
        if (canon(here) !== canon(there)) {
            differences.push({ subject: `Setting ${key}`, detail: `This sandbox runs ${shortValue(here)}; the runner has ${shortValue(there)}.` });
        }
    }
    return differences;
};

/* ---- the emitter: deterministic TOML with the comments a reviewed file owes its reader ----
 *
 * Hand-rolled rather than a library's stringify for two properties no library promises together: byte-identical
 * output for equal input (fixed section order, sorted keys, one spelling per value shape), and comment lines,
 * which are most of why the format is TOML at all. Scope is exactly what the definition schema can hold:
 * strings, numbers, booleans, arrays, and plain objects (inline tables), plus one multi-line literal for the
 * Dockerfile. Anything else in a value is a bug upstream and throws rather than emitting a file that will not
 * parse back. */

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const tomlKey = (name: string): string => (BARE_KEY.test(name) ? name : JSON.stringify(name));

// JSON string escaping is a strict subset of TOML basic-string escaping, so one spelling serves both.
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

// The Dockerfile block, as a multi-line LITERAL so its backslashes and quotes read exactly as written. The
// escaped fallback covers the one content a literal cannot hold (a ''' inside), rather than refusing it.
const tomlBlock = (value: string): string => {
    const withNewline = value.endsWith("\n") ? value : `${value}\n`;
    // eslint-disable-next-line no-control-regex
    if (withNewline.includes("'''") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(withNewline) || withNewline.includes("\r")) {
        return JSON.stringify(value);
    }
    return `'''\n${withNewline}'''`;
};

export const emitDefinitionToml = (definition: SandboxDefinition, omitted: readonly DefinitionAction[] = []): string => {
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

/* ---- parsing: strict TOML, then the contract schema, each failure named ---- */

export const parseDefinitionToml = (text: string): SandboxDefinition => {
    let raw: unknown;
    try {
        raw = parse(text);
    } catch (error) {
        throw new DefinitionFormatError(`this is not readable as TOML: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = SandboxDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
        const problems = parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") === "" ? "document" : issue.path.join(".")}: ${issue.message}`)
            .join("; ");
        throw new DefinitionFormatError(`this is TOML but not a sandbox definition: ${problems}`);
    }
    return parsed.data;
};

/* ---- drift: one line per difference between a definition and this sandbox's derived one ----
 *
 * Pure over two definitions, so it needs no services and answers identically wherever it runs. Settings
 * compare through the schema defaults, a key absent on either side means "the default", so a definition that
 * omits a flag never reads as drift against a sandbox that also runs the default. */

const shortValue = (value: unknown): string => {
    const spelled = canon(value);
    return spelled.length > 60 ? `${spelled.slice(0, 57)}…` : spelled;
};

const trimmed = (value: string | undefined): string => (value ?? "").trim();

export const definitionDiff = (current: SandboxDefinition, target: SandboxDefinition): DefinitionAction[] => {
    const differences: DefinitionAction[] = [];
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
            differences.push({ subject: `Setting ${key}`, detail: `The definition says ${shortValue(there)}; this sandbox has ${shortValue(here)}.` });
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
