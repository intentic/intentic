import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import {
    type ArrivalItem,
    type ArrivalReport,
    type DefinitionDiff,
    type DefinitionExport,
    type NeedsAction,
    type SandboxDefinition,
    SandboxSettingsSchema,
} from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import { composeEnvironment, draftsDir } from "../environment/environment.js";
import { repoGitDir } from "../history/history.js";
import { isValidRepoId } from "../workspace/layout/repo-discovery.js";
import { definitionDiff, deriveDefinition, emitDefinitionToml, parseDefinitionToml } from "./definition.js";
import { adoptWorkspaceRemote, workspaceIsPristine, workspaceRemoteUrl } from "./workspace-repo.js";

// Parser and apply loop for sandbox.toml, one of the arrival pipeline's four sources. Apply re-derives its checklist
// from the held document, never the wire plan; nothing lands verbatim, so it's all editable afterward. Lands beside
// what a sandbox already has, never over it; the overlay lands as a draft, not an approved custom section.

const strippedSettings = (definition: SandboxDefinition): Record<string, unknown> =>
    Object.fromEntries(Object.entries(definition.settings).filter(([, value]) => value !== undefined));

const dockerfileOf = (definition: SandboxDefinition): string => (definition.environment.dockerfile ?? "").trim();

// Derived fresh on every call, so plan and apply can't disagree. Every row is `recommended: true` with no `secrets`, by
// construction: a definition states a shape its owner already chose, and only secret names travel.
export const definitionItems = async (services: Services, definition: SandboxDefinition): Promise<ArrivalItem[]> => {
    const items: ArrivalItem[] = [];
    const row = (
        entry: Omit<ArrivalItem, "recommended" | "secrets"> & { readonly recommended?: boolean },
    ): ArrivalItem => ({ recommended: true, secrets: [], ...entry });
    // Workspace goes first: a repo cloned before it would block the tree's own checkout over that directory.
    const workspace = definition.workspace;
    if (workspace !== undefined) {
        const published = await workspaceRemoteUrl(services.workspace.root);
        const pristine = await workspaceIsPristine(services.workspace.root);
        items.push(row({
            id: "workspace",
            group: "workspace",
            label: "The workspace itself",
            detail: `${workspace.remote}${workspace.ref === undefined ? "" : ` @ ${workspace.ref}`}; its notes, skills, personas, designs and approvals land in /work`,
            applicable: published === undefined && pristine,
            ...(published !== undefined
                ? { reason: `this workspace is already published at ${published}; a definition lands beside what is there, never over it` }
                : pristine
                  ? {}
                  : { reason: "this workspace already has a history of its own; a definition lands beside what is there, never over it" }),
        }));
    }
    for (const repo of definition.repositories) {
        const invalid = !isValidRepoId(repo.id);
        const exists = !invalid && existsSync(join(services.workspace.root, repo.id));
        items.push(row({
            id: `repo:${repo.id}`,
            group: "repo",
            label: `Repository ${repo.id}`,
            detail: `${repo.remote}${repo.ref === undefined ? "" : ` @ ${repo.ref}`}`,
            applicable: !invalid && !exists,
            ...(invalid
                ? { reason: "not a valid repository id for this workspace" }
                : exists
                  ? { reason: "already in the workspace; a definition lands beside what is there, never over it" }
                  : {}),
        }));
    }
    if (dockerfileOf(definition) !== "") {
        items.push(row({
            id: "environment",
            group: "environment",
            label: "Environment overlay",
            detail: "Lands as a proposal on the Environment card; nothing builds until you approve it and rebuild.",
            applicable: true,
        }));
    }
    for (const capability of definition.capabilities) {
        const exists = (await services.capabilities.get(capability.id)) !== undefined;
        items.push(row({
            id: `capability:${capability.id}`,
            group: "capability",
            label: `Connection ${capability.id}`,
            detail: `${capability.kind}; lands unauthenticated, waiting for its credential`,
            applicable: !exists,
            ...(exists ? { reason: "a connection with this id already exists" } : {}),
        }));
    }
    const settingsKeys = Object.keys(strippedSettings(definition)).toSorted();
    if (settingsKeys.length > 0) {
        items.push(row({
            id: "settings",
            group: "settings",
            label: "Agent settings",
            detail: settingsKeys.join(", "),
            applicable: true,
        }));
    }
    return items;
};

// What no apply can do for the owner, stated at preview time and again on the report: a checklist that looks complete
// is worse than one that visibly isn't.
export const definitionActions = (definition: SandboxDefinition): NeedsAction[] => {
    const actions: NeedsAction[] = [];
    // Generic, since the tree isn't fetched yet to know what specifically got switched off; the report names the
    // specifics.
    if (definition.workspace !== undefined) {
        actions.push({
            subject: "What the workspace brings arrives switched off",
            detail: "A workspace repo carries a sandbox's own way of working. Anything in it that acts by itself — automations, workspace extensions, an environment overlay — lands disabled or as a proposal, and the report names each one so you can turn on what you trust.",
        });
    }
    if (dockerfileOf(definition) !== "") {
        actions.push({
            subject: "Approve and rebuild the environment",
            detail: "The overlay lands as a proposal. Review it on the Environment card, approve it, then run the rebuild command the card shows; until then this sandbox stays on its current image.",
        });
    }
    if (definition.capabilities.length > 0) {
        actions.push({
            subject: "Reconnect capabilities",
            detail: `Each connection arrives listed but unauthenticated. Open these on the Capabilities view and enter the credential each one asks for: ${definition.capabilities.map((capability) => `${capability.id} (${capability.kind})`).join(", ")}.`,
        });
    }
    if (definition.secrets.length > 0) {
        actions.push({
            subject: "Enter secret values",
            detail: `Secret names travel, values never do. Store values for: ${definition.secrets.join(", ")}.`,
        });
    }
    return actions;
};

// Exported apart from the arrival surface: main.ts's definitionSeed applies everything applicable with no browser
// involved, using the same report shape either caller renders or logs.
export const applyDefinitionItems = async (
    services: Services,
    definition: SandboxDefinition,
    pick: (item: ArrivalItem) => boolean,
): Promise<ArrivalReport> => {
    const items = await definitionItems(services, definition);
    const applied: ArrivalReport["applied"] = [];
    const failed: ArrivalReport["failed"] = [];
    // What the workspace arrival switched off, learned only by doing it, added to the report.
    const gated: NeedsAction[] = [];
    // Whether the environment item will already park this overlay as a proposal: if so, a workspace carrying the
    // identical custom section must not park a second copy, or the composed proposal installs it twice.
    const overlayHandledBySection = items.some((item) => item.group === "environment" && item.applicable && pick(item));
    let touchedCapabilities = false;
    for (const item of items) {
        if (!item.applicable || !pick(item)) {
            continue;
        }
        try {
            if (item.group === "workspace") {
                const workspace = definition.workspace;
                if (workspace === undefined) {
                    throw new Error("the held definition no longer names a workspace");
                }
                const arrival = await adoptWorkspaceRemote(services, workspace, { overlayHandledBySection });
                gated.push(...arrival.actions);
                // A delivered capability manifest converges like an upserted one; handled once after the loop.
                touchedCapabilities = true;
            } else if (item.group === "repo") {
                const repo = definition.repositories.find((entry) => `repo:${entry.id}` === item.id);
                if (repo === undefined) {
                    throw new Error("the held definition no longer names this repository");
                }
                // A nested id ("clients/foo") may need its parent dir made first; git creates the leaf, not the path.
                await mkdir(dirname(join(services.workspace.root, repo.id)), { recursive: true });
                await services.git.clone(services.workspace.root, repo.id, repo.remote, {
                    ...(repo.ref === undefined ? {} : { branch: repo.ref }),
                    separateGitDir: repoGitDir(services.config.historyRoot, repo.id),
                });
            } else if (item.group === "environment") {
                // Draft path, not the approved custom section; composeEnvironment folds it into the proposal to review.
                await services.files.write(join(draftsDir(services), "definition.Dockerfile"), `${dockerfileOf(definition)}\n`);
            } else if (item.group === "capability") {
                const capability = definition.capabilities.find((entry) => `capability:${entry.id}` === item.id);
                if (capability === undefined) {
                    throw new Error("the held definition no longer names this connection");
                }
                // Manifest entry only: no handler runs, since handlers assume a credential a definition never carries.
                await services.capabilities.upsert(capability);
                touchedCapabilities = true;
            } else {
                const merged = SandboxSettingsSchema.parse({ ...(await services.sandboxSettings.get()), ...strippedSettings(definition) });
                await services.sandboxSettings.set(merged);
            }
            applied.push({ id: item.id, group: item.group, label: item.label });
        } catch (error) {
            failed.push({ id: item.id, label: item.label, error: errorMessage(error) });
        }
    }
    if (touchedCapabilities) {
        // Converges once after the loop, folding fragments into the overlay and updating the translator.
        await composeEnvironment(services);
        await syncEndpointCompat(services);
    }
    services.history.notifyUserWrite();
    // `refused` stays empty: a definition is parsed in full or rejected outright, no partial middle case.
    return { applied, failed, refused: [], needsAction: [...definitionActions(definition), ...gated] };
};

// Replaces settings rather than merging beside them: a runner's parent is its whole authority, so keys it no longer
// sets must revert to default via schema parsing. Returns the keys now holding non-default values.
export const adoptDefinitionSettings = async (services: Services, definition: SandboxDefinition): Promise<string[]> => {
    const stripped = strippedSettings(definition);
    await services.sandboxSettings.set(SandboxSettingsSchema.parse(stripped));
    return Object.keys(stripped).toSorted();
};

// Both `derive` and `diff` only read: one emits what this sandbox is, the other compares it to a file; applying a
// definition is the arrival pipeline's job, not this interface's.
export interface Definitions {
    // Live sandbox as sandbox.toml, derived on every call, never stored.
    readonly derive: () => Promise<DefinitionExport>;
    // Where this sandbox stands relative to a definition file, one line per difference.
    readonly diff: (toml: string) => Promise<DefinitionDiff>;
}

export const createDefinitions = (services: Services): Definitions => ({
    derive: async () => {
        const { definition, omitted } = await deriveDefinition(services);
        return { toml: emitDefinitionToml(definition, omitted), omitted };
    },
    diff: async (toml) => {
        const target = parseDefinitionToml(toml);
        const { definition: current } = await deriveDefinition(services);
        return { differences: definitionDiff(current, target) };
    },
});
