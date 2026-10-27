import type { DefinitionDiff, DefinitionExport, WorkspacePublishResult, WorkspaceRemote } from "@intentic/sandbox-contract/state/definition";
import type { NeedsAction } from "@intentic/sandbox-contract/policy/needs-action";
import { refuse } from "@intentic/contract-serve";
import { demoCapabilities } from "../../fixture/sandbox";
import { REMOTE_REPOS, REPOS } from "../../fixture/workspace";
import { DESK_SANDBOX_NAME } from "../../fixture/desk";
import { deskEdition } from "../../mode";
import { environmentNow } from "./environment";
import { pause } from "./machineKit";

// This sandbox's definition (the daemon's definition/ emitter): sandbox.toml derived from what is here now, the
// differences from one the reader picked, and publishing the workspace repository so the definition can name it.

export const DEMO_SANDBOX_NAME = deskEdition ? DESK_SANDBOX_NAME : `acme-shop`;
const BASE_IMAGE = `ghcr.io/intentic/sandbox:stable`;
// Creating a repository and pushing to it takes a few round trips to the host.
const PUBLISH_MS = 2_600;

// Published from the start, as the Move out panel first reads it; a publish moves it to wherever the press put it.
const workspace: WorkspaceRemote = { remote: `https://github.com/acme/intentic-sandbox-ada.git`, branch: `main`, hosts: [`github.com`] };

export const workspaceRemote = (): WorkspaceRemote => ({ ...workspace, hosts: [...workspace.hosts] });

/** Wires `/work` to a remote: the one given, or a new repository on the first connected host. */
export const publishWorkspace = async (input: { remote?: string; name?: string; owner?: string }): Promise<WorkspacePublishResult> => {
    const host = workspace.hosts[0];
    if (input.remote === undefined && host === undefined) {
        return refuse(`connect a git account first, or paste the address of a repository to push to`, 409);
    }
    await pause(PUBLISH_MS);
    const remote = input.remote ?? `https://${host}/${input.owner ?? `acme`}/${input.name ?? DEMO_SANDBOX_NAME}.git`;
    workspace.remote = remote;
    workspace.branch = `main`;
    return { remote, branch: `main`, created: input.remote === undefined };
};

const quoted = (value: string): string => JSON.stringify(value);

// The repositories a definition can name by their remote; one with none is listed as left out rather than invented.
const repositories = (): { readonly id: string; readonly remote: string | undefined }[] =>
    REPOS.map((id) => {
        const known = REMOTE_REPOS.find((entry) => entry.repo === id);
        return { id, remote: known === undefined ? undefined : `https://${known.host}/${known.project}.git` };
    });

// Every connection in full, never its credential: what a sandbox built from this asks its owner to reconnect.
const capabilityTables = (): string[] =>
    demoCapabilities().map((capability) =>
        [
            `[[capabilities]]`,
            `id = ${quoted(capability.id)}`,
            `kind = ${quoted(capability.kind)}`,
            ...Object.entries(capability.config).map(([key, value]) => `config.${key} = ${JSON.stringify(value)}`),
        ].join(`\n`),
    );

const secretNames = (): string[] => [...new Set(demoCapabilities().flatMap((capability) => capability.secrets.map((key) => `${capability.id}.${key}`)))];

export const definitionNow = (): DefinitionExport => {
    const overlay = environmentNow().approved?.content;
    const repos = repositories();
    const toml = [
        `# sandbox.toml: what ${DEMO_SANDBOX_NAME} is made of, without any of its credentials.`,
        `schemaVersion = 1`,
        `name = ${quoted(DEMO_SANDBOX_NAME)}`,
        `secrets = [${secretNames().map(quoted).join(`, `)}]`,
        ``,
        `[environment]`,
        `baseImage = ${quoted(BASE_IMAGE)}`,
        ...(overlay === undefined ? [] : [`dockerfile = """\n${overlay}"""`]),
        ``,
        ...(workspace.remote === undefined ? [] : [`[workspace]`, `remote = ${quoted(workspace.remote)}`, `ref = ${quoted(workspace.branch ?? `main`)}`, ``]),
        ...repos.flatMap((repo) => (repo.remote === undefined ? [] : [`[[repositories]]`, `id = ${quoted(repo.id)}`, `remote = ${quoted(repo.remote)}`, ``])),
        ...capabilityTables().flatMap((table) => [table, ``]),
        `[settings]`,
        `timezone = "Europe/Warsaw"`,
        `personaRouting = true`,
        ``,
    ].join(`\n`);
    const omitted: NeedsAction[] = repos
        .filter((repo) => repo.remote === undefined)
        .map((repo) => ({ subject: `Repository ${repo.id}`, detail: `It has no remote to be named by, so a definition cannot bring it along; publish it or move it with a bundle.` }));
    return { toml, omitted };
};

// The ids a document lists under one array of tables, read the way the emitter writes them: `id = "…"` after the header.
const idsUnder = (toml: string, table: string): Set<string> =>
    new Set([...toml.matchAll(new RegExp(`\\[\\[${table}\\]\\]\\s*\\nid = "([^"]+)"`, `g`))].map((match) => match[1] ?? ``));

const compareIds = (label: string, ours: Set<string>, theirs: Set<string>): NeedsAction[] => [
    ...[...theirs].filter((id) => !ours.has(id)).map((id) => ({ subject: `${label} ${id}`, detail: `The file names it; this sandbox does not have it.` })),
    ...[...ours].filter((id) => !theirs.has(id)).map((id) => ({ subject: `${label} ${id}`, detail: `This sandbox has it; the file does not name it.` })),
];

/** Where this sandbox stands against a definition the reader picked: one line per difference, none when they agree. */
export const definitionDiff = (theirs: string): DefinitionDiff => {
    if (!/^\s*schemaVersion\s*=\s*1\s*$/m.test(theirs)) {
        return refuse(`that is not a sandbox.toml this sandbox can read: it names no schemaVersion = 1`, 400);
    }
    const ours = definitionNow().toml;
    const differences = [
        ...compareIds(`Repository`, idsUnder(ours, `repositories`), idsUnder(theirs, `repositories`)),
        ...compareIds(`Connection`, idsUnder(ours, `capabilities`), idsUnder(theirs, `capabilities`)),
    ];
    const overlay = (toml: string): string => /dockerfile = """\n([\s\S]*?)"""/.exec(toml)?.[1]?.trim() ?? ``;
    if (overlay(ours) !== overlay(theirs)) {
        differences.push({ subject: `Environment`, detail: `The approved image steps differ; applying the file would propose its steps for the owner to approve.` });
    }
    return { differences };
};
