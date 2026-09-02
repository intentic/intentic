import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import {
    type Capability,
    CapabilitySchema,
    type DefinitionAction,
    type DefinitionRepository,
    type DefinitionWorkspace,
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
 * marked `versioned` must appear in exactly one of the three lists below. Adding a config surface to the daemon
 * therefore forces the question this module exists to ask, "how does this travel?", the same discipline the
 * portability classes enforce one level down.
 *
 * TWO DOORS, NOT TWO CATEGORIES OF WORTH. `versioned` means "tracked in the workspace repo", so once that repo
 * can be named by remote (`[workspace]`), EVERY versioned manifest travels — the only question left is HOW.
 * A SOURCE is read into a typed section of the document, which is what lets it travel without a workspace
 * remote at all and, more importantly, lets it land through a native write path with the consent that path
 * enforces. Everything else RIDES the workspace repo as the file it already is. The second list used to be
 * spelled "bundle territory" on every row; that stopped being true the moment a workspace could be published,
 * and the notes now say what each one actually does on arrival. */

// The manifests deriveDefinition reads. Each is a source of one section of the emitted document, and each is
// therefore also the section that WINS over whatever a workspace checkout delivered for it.
export const DEFINITION_SOURCES: readonly string[] = [
    ".intentic/config/capabilities.json",
    ".intentic/config/environment.custom.Dockerfile",
    ".intentic/config/settings.json",
];

/* The manifests that travel inside the workspace repo rather than as sections. Authored content, all of it: it
 * has no source anywhere but this workspace, which is exactly what a git remote gives it. A definition with no
 * `[workspace]` section carries none of this, and the export says so in `omitted` rather than leaving the owner
 * to find out. Where arrival needs a caveat, the note is that caveat. */
export const DEFINITION_WORKSPACE: readonly { readonly path: string; readonly note: string }[] = [
    {
        path: ".intentic/config/personas.json",
        note: "Personas arrive naming accounts the target has not connected; each reads as broken until its capability is.",
    },
    { path: ".intentic/config/personas/", note: "Persona prompt files, beside the cards that name them." },
    { path: ".intentic/config/approvals/", note: "Approvals arrive awaiting a yes, which is the only state they act in." },
    {
        path: ".intentic/config/automations.json",
        note: "Arrive DISABLED: the scheduler fires enabled automations, and nobody consented to a stranger's schedule.",
    },
    { path: ".intentic/config/workflows.json", note: "Workflow designs are inert until someone runs one." },
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

/* The remote a definition can reference for ONE checkout, or the reason there is none. Every git read is
 * total: a checkout whose git dir is broken (a dangling pointer mid-restore) reports as unreferenceable rather
 * than failing the export. Shared by the nested repositories and by the workspace repo itself, which differ
 * only in how the refusal has to read to the owner. */
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
const repositoryOf = async (root: string, id: string): Promise<{ repo?: DefinitionRepository; omitted?: DefinitionAction }> => {
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

/* The workspace repo itself. Its refusal is the discoverability of the whole `[workspace]` feature: an owner
 * who has never published /work reads, on the card, exactly what publishing would buy them and what the
 * document is missing without it. */
const workspaceOf = async (root: string): Promise<{ workspace?: DefinitionWorkspace; omitted?: DefinitionAction }> => {
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
    // The workspace first, in the document and in the omissions: it is the section that decides whether the
    // sandbox's own way of working travels at all, so an owner reading the export's refusals reads it first.
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
            ...(workspace === undefined ? {} : { workspace }),
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
    // TOML's opening newline is trimmed from a multi-line literal, but its closing newline is content. A
    // value without one therefore cannot use the readable block spelling without silently gaining a byte.
    if (!value.endsWith("\n")) {
        return JSON.stringify(value);
    }
    // eslint-disable-next-line no-control-regex
    if (value.includes("'''") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || value.includes("\r")) {
        return JSON.stringify(value);
    }
    return `'''\n${value}'''`;
};

/* Every emitted document is the READER'S file: they commit it, hand-edit it, apply it somewhere else. Nothing
 * here is ever written back into this sandbox, so no copy carries a "managed, your edits will be overwritten"
 * header — there is no copy that would be true of. */
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

/* ---- parsing: strict TOML, then the contract schema, each failure named ---- */

const recordLike = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Shared capability schemas also serve JSON APIs where accepting a newer producer's extra field can be a
// useful compatibility posture. A reviewed definition wants the opposite: no TOML key may disappear during
// parsing and leave the owner believing it applied. Compare only keys the input actually supplied, so schema
// defaults added to the parsed side are harmless while every stripped key, at any depth, is named.
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

// One checkout reference as a person reads it, the spelling both the repository lines and the workspace lines
// below use, so "where is it and on what branch" reads the same wherever it is answered.
const reference = (found: { readonly remote: string; readonly ref?: string | undefined }): string =>
    `${found.remote}${found.ref === undefined ? "" : ` @ ${found.ref}`}`;

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
    /* The workspace repo, before the repositories, for the reason it is emitted first: it decides whether the
     * sandbox's own content is part of the comparison at all. A definition with no `[workspace]` against a
     * published workspace is a real difference and says so, rather than reading as agreement by omission. */
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
