import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
    type DefinitionAction,
    type DefinitionApply,
    type DefinitionExport,
    type DefinitionDiff,
    type DefinitionItem,
    type DefinitionPlan,
    type DefinitionReport,
    previewLabel,
    type SandboxDefinition,
    SandboxSettingsSchema,
} from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import { composeEnvironment, draftsDir } from "../environment/environment.js";
import { repoGitDir } from "../history/history.js";
import { isValidRepoId } from "../workspace/repo-discovery.js";
import { definitionDiff, DefinitionFormatError, deriveDefinition, emitDefinitionToml, parseDefinitionToml } from "./definition.js";

/* APPLYING A DEFINITION, preview-first, through the same native write paths the product's own surfaces use.
 *
 * The migration surface's rules, kept on purpose (migrations/migrations.ts argues each): ONE held definition
 * at a time, in memory, under a token; the APPLY RE-DERIVES the checklist from the held document and honors
 * the ticked ids against that, never against the wire plan the browser rendered; and nothing lands verbatim,
 * a repo arrives through the daemon's own clone (separate git dir and all), a capability through the manifest
 * store, settings through the settings store, so everything an applied definition creates is editable and
 * deletable in the ordinary UI the day after.
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

// The checklist, derived fresh on every call so plan and apply cannot disagree about what is applicable.
const itemsOf = async (services: Services, definition: SandboxDefinition): Promise<DefinitionItem[]> => {
    const items: DefinitionItem[] = [];
    for (const repo of definition.repositories) {
        const invalid = !isValidRepoId(repo.id);
        const exists = !invalid && existsSync(join(services.workspace.root, repo.id));
        items.push({
            id: `repo:${repo.id}`,
            kind: "repo",
            label: `Repository ${repo.id}`,
            detail: `${repo.remote}${repo.ref === undefined ? "" : ` @ ${repo.ref}`}`,
            applicable: !invalid && !exists,
            ...(invalid
                ? { reason: "not a valid repository id for this workspace" }
                : exists
                  ? { reason: "already in the workspace; a definition lands beside what is there, never over it" }
                  : {}),
        });
    }
    if (dockerfileOf(definition) !== "") {
        items.push({
            id: "environment",
            kind: "environment",
            label: "Environment overlay",
            detail: "Lands as a proposal on the Environment card; nothing builds until you approve it and rebuild.",
            applicable: true,
        });
    }
    for (const capability of definition.capabilities) {
        const exists = (await services.capabilities.get(capability.id)) !== undefined;
        items.push({
            id: `capability:${capability.id}`,
            kind: "capability",
            label: `Connection ${capability.id}`,
            detail: `${capability.kind}; lands unauthenticated, waiting for its credential`,
            applicable: !exists,
            ...(exists ? { reason: "a connection with this id already exists" } : {}),
        });
    }
    const settingsKeys = Object.keys(strippedSettings(definition)).toSorted();
    if (settingsKeys.length > 0) {
        items.push({
            id: "settings",
            kind: "settings",
            label: "Agent settings",
            detail: settingsKeys.join(", "),
            applicable: true,
        });
    }
    return items;
};

// What no apply can do for the owner, stated at PREVIEW time and again on the report, the import report's
// honesty rule: a list that looks complete is worse than one that is visibly missing.
const actionsFor = (definition: SandboxDefinition): DefinitionAction[] => {
    const actions: DefinitionAction[] = [];
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

/* One pass over the applicable, picked items. Exported apart from the surface because the boot seed
 * (main.ts's definitionSeed step) applies everything applicable with no browser in the loop; the report it
 * returns is the same shape either caller logs or renders. */
export const applyDefinitionItems = async (
    services: Services,
    definition: SandboxDefinition,
    pick: (item: DefinitionItem) => boolean,
): Promise<DefinitionReport> => {
    const items = await itemsOf(services, definition);
    const applied: DefinitionReport["applied"] = [];
    const failed: DefinitionReport["failed"] = [];
    let touchedCapabilities = false;
    for (const item of items) {
        if (!item.applicable || !pick(item)) {
            continue;
        }
        try {
            if (item.kind === "repo") {
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
                if (!repo.id.includes("/")) {
                    // Mint the preview route at clone time, the addRepo route's own rule: hostnames must
                    // predate the first browser lookup or an early NXDOMAIN gets negative-cached.
                    void services.ensurePreviewRoutes([previewLabel(repo.id)]);
                }
            } else if (item.kind === "environment") {
                // The draft path, not the approved custom section: composeEnvironment folds drafts into the
                // proposal the owner reviews, which is the approval gate this surface promises.
                await services.files.write(join(draftsDir(services), "definition.Dockerfile"), `${dockerfileOf(definition)}\n`);
            } else if (item.kind === "capability") {
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
            applied.push({ id: item.id, label: item.label });
        } catch (error) {
            failed.push({ id: item.id, label: item.label, error: error instanceof Error ? error.message : String(error) });
        }
    }
    if (touchedCapabilities) {
        // The capability add route's own convergence, once, after the loop: fragments fold into the composed
        // overlay, and the translator learns about any endpoint kinds that just arrived.
        await composeEnvironment(services);
        await syncEndpointCompat(services);
    }
    services.history.notifyUserWrite();
    return { applied, failed, needsAction: actionsFor(definition) };
};

export interface Definitions {
    // The live sandbox as sandbox.toml, derived on every call, never stored.
    readonly derive: () => Promise<DefinitionExport>;
    readonly plan: (toml: string) => Promise<DefinitionPlan>;
    readonly apply: (input: DefinitionApply) => Promise<DefinitionReport>;
    // Where this sandbox stands relative to a definition file, one line per difference.
    readonly diff: (toml: string) => Promise<DefinitionDiff>;
    readonly abandon: () => boolean;
}

export const createDefinitions = (services: Services): Definitions => {
    let pending: { readonly token: string; readonly definition: SandboxDefinition } | undefined;
    return {
        derive: async () => {
            const { definition, omitted } = await deriveDefinition(services);
            return { toml: emitDefinitionToml(definition, omitted), omitted };
        },
        plan: async (toml) => {
            const definition = parseDefinitionToml(toml);
            pending = { token: randomUUID(), definition };
            return {
                token: pending.token,
                ...(definition.name === undefined ? {} : { name: definition.name }),
                items: await itemsOf(services, definition),
                needsAction: actionsFor(definition),
            };
        },
        apply: async (input) => {
            if (pending === undefined || pending.token !== input.token) {
                throw new DefinitionFormatError("no held definition matches that plan: upload it again and re-review");
            }
            const held = pending;
            // Consumed whatever happens item by item, the migration surface's rule: the failures a re-run can
            // fix are about the target, not the held bytes.
            pending = undefined;
            const chosen = new Set(input.items);
            return applyDefinitionItems(services, held.definition, (item) => chosen.has(item.id));
        },
        diff: async (toml) => {
            const target = parseDefinitionToml(toml);
            const { definition: current } = await deriveDefinition(services);
            return { differences: definitionDiff(current, target) };
        },
        abandon: () => {
            const had = pending !== undefined;
            pending = undefined;
            return had;
        },
    };
};
