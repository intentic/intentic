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
import { isValidRepoId } from "../workspace/repo-discovery.js";
import { definitionDiff, deriveDefinition, emitDefinitionToml, parseDefinitionToml } from "./definition.js";
import { adoptWorkspaceRemote, workspaceIsPristine, workspaceRemoteUrl } from "./workspace-repo.js";

/* A DEFINITION ARRIVING, as one of the four sources the arrival pipeline reads (portability/arrival.ts holds
 * the pipeline; this file is the parser and the apply loop for `sandbox.toml`).
 *
 * The rules the pipeline enforces on every source, argued here first: ONE held artifact at a time, under a
 * token; the APPLY RE-DERIVES the checklist from the held document and honors the ticked ids against that,
 * never against the wire plan the browser rendered; and nothing lands verbatim, a repo arrives through the
 * daemon's own clone (separate git dir and all), a capability through the manifest store, settings through
 * the settings store, so everything an applied definition creates is editable and deletable in the ordinary
 * UI the day after.
 *
 * TWO THINGS ARE DELIBERATELY WEAKER THAN THEY COULD BE. A definition lands BESIDE what a sandbox already
 * has, never over it: an existing repo directory or capability id renders its item inapplicable with the
 * reason, because "make this sandbox match the file" is the diff surface's job, not the apply's. And the
 * overlay Dockerfile lands as an agent-style DRAFT (environment.d/), not as the approved custom section the
 * bundle restore writes: a bundle is the owner's own sandbox coming back, while a definition is a file
 * anyone may have handed them, so its one piece of executable content goes to the approval gate. */

const strippedSettings = (definition: SandboxDefinition): Record<string, unknown> =>
    Object.fromEntries(Object.entries(definition.settings).filter(([, value]) => value !== undefined));

const dockerfileOf = (definition: SandboxDefinition): string => (definition.environment.dockerfile ?? "").trim();

/* The checklist, derived fresh on every call so plan and apply cannot disagree about what is applicable.
 *
 * Every row is `recommended` and carries no `secrets`, and both are true by construction rather than by
 * choice: a definition states a shape its owner already decided on, so there is nothing here to advise
 * against, and it carries secret NAMES only, so the apply's credential consent has nothing to gate. The two
 * fields exist for the sources where they do vary (an assistant's home directory), and stating them flatly
 * here is what lets one checklist render all four. */
export const definitionItems = async (services: Services, definition: SandboxDefinition): Promise<ArrivalItem[]> => {
    const items: ArrivalItem[] = [];
    const row = (
        entry: Omit<ArrivalItem, "recommended" | "secrets"> & { readonly recommended?: boolean },
    ): ArrivalItem => ({ recommended: true, secrets: [], ...entry });
    /* The workspace FIRST, in the checklist and therefore in the apply loop: it materializes a whole tree, and
     * a repo cloned before it would be a directory that tree could not be checked out over. */
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

// What no apply can do for the owner, stated at PREVIEW time and again on the report, the arrival pipeline's
// honesty rule: a list that looks complete is worse than one that is visibly missing.
export const definitionActions = (definition: SandboxDefinition): NeedsAction[] => {
    const actions: NeedsAction[] = [];
    /* Said at PREVIEW time, before the tree is fetched and therefore before anyone can know WHICH things it
     * carries: a workspace repo is authored content, and the parts of it that act unattended land off. The
     * report replaces this with the specific list of what was actually switched off. */
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

/* One pass over the applicable, picked items. Exported apart from the arrival surface because the boot seed
 * (main.ts's definitionSeed step) applies everything applicable with no browser in the loop; the report it
 * returns is the same shape either caller logs or renders. */
export const applyDefinitionItems = async (
    services: Services,
    definition: SandboxDefinition,
    pick: (item: ArrivalItem) => boolean,
): Promise<ArrivalReport> => {
    const items = await definitionItems(services, definition);
    const applied: ArrivalReport["applied"] = [];
    const failed: ArrivalReport["failed"] = [];
    // What the workspace arrival switched off, learned only by doing it, so it rides back on the report
    // beside the actions the document could predict.
    const gated: NeedsAction[] = [];
    /* Whether the `[environment]` item is going to park this definition's overlay as a proposal anyway. When it
     * is, a workspace checkout carrying the identical custom section must not park a SECOND copy: the two are
     * derived from the same file on the source, and the composed proposal would install everything twice. */
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
                // The tree may have delivered a capability manifest, which reaches the composed overlay and
                // the endpoint translator exactly as an upserted capability does; converge once after the loop.
                touchedCapabilities = true;
            } else if (item.group === "repo") {
                const repo = definition.repositories.find((entry) => `repo:${entry.id}` === item.id);
                if (repo === undefined) {
                    throw new Error("the held definition no longer names this repository");
                }
                // A nested id ("clients/foo") clones under a parent the target may not have yet; git creates
                // the leaf, not the path to it.
                await mkdir(dirname(join(services.workspace.root, repo.id)), { recursive: true });
                await services.git.clone(services.workspace.root, repo.id, repo.remote, {
                    ...(repo.ref === undefined ? {} : { branch: repo.ref }),
                    separateGitDir: repoGitDir(services.config.historyRoot, repo.id),
                });
            } else if (item.group === "environment") {
                // The draft path, not the approved custom section: composeEnvironment folds drafts into the
                // proposal the owner reviews, which is the approval gate this surface promises.
                await services.files.write(join(draftsDir(services), "definition.Dockerfile"), `${dockerfileOf(definition)}\n`);
            } else if (item.group === "capability") {
                const capability = definition.capabilities.find((entry) => `capability:${entry.id}` === item.id);
                if (capability === undefined) {
                    throw new Error("the held definition no longer names this connection");
                }
                // The manifest entry only, the restore's posture: no handler runs, because handlers assume the
                // credential a definition never carries. The card renders unauthenticated and reconnect is the
                // needsAction beside it.
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
        // The capability add route's own convergence, once, after the loop: fragments fold into the composed
        // overlay, and the translator learns about any endpoint kinds that just arrived.
        await composeEnvironment(services);
        await syncEndpointCompat(services);
    }
    services.history.notifyUserWrite();
    // `refused` is empty and stays empty: a definition is a document this daemon parsed in full or rejected
    // outright, so there is no class of "saw it, will not offer it" the way a tar or a foreign home has.
    return { applied, failed, refused: [], needsAction: [...definitionActions(definition), ...gated] };
};

/* The RUNNER'S way of taking a definition's settings: REPLACE, not the merge-beside applyDefinitionItems does.
 * The owner-facing apply lands beside what a sandbox already has because the file may be anyone's; a runner's
 * parent is its whole authority, so "make this runner match" must also return to default every key the parent
 * no longer sets — schema-parsing the stripped section does exactly that, absent keys re-materialize as
 * defaults. Returns the keys now holding non-default values, the answer the runner contract promises. */
export const adoptDefinitionSettings = async (services: Services, definition: SandboxDefinition): Promise<string[]> => {
    const stripped = strippedSettings(definition);
    await services.sandboxSettings.set(SandboxSettingsSchema.parse(stripped));
    return Object.keys(stripped).toSorted();
};

/* THE TWO VERBS THAT ARE NOT AN ARRIVAL, and the reason this interface is now two functions rather than six.
 * Deriving the document and comparing against one both READ: one emits what this sandbox is, the other says
 * where it stands relative to a file, and neither writes a byte. Applying one is the arrival pipeline's, and
 * moving it there is what stopped `sandbox.toml` having a plan/apply/report trio that did the same job as the
 * bundle's, differently. */
export interface Definitions {
    // The live sandbox as sandbox.toml, derived on every call, never stored.
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
