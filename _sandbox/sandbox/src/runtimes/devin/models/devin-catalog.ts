import { mkdir } from "node:fs/promises";
import { methods } from "@agentclientprotocol/sdk";
import type { Model } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { discoveredCatalog } from "../../../agent/models/model-catalog.js";
import { opt } from "../../../opt.js";
import { cacheFile } from "../../../store/open-document.js";
import type { AcpConnections } from "../../acp/acp-connection.js";
import { type ModelChoice, sessionModelsOf, sessionThoughtsOf, thoughtTiers } from "../../acp/acp-model.js";
import { type DevinStore, liveDevinAccounts } from "../accounts/devin-credentials.js";
import { devinAgentId, devinCli, devinLaunch } from "../devin-cli.js";

// Devin's model catalog on the shared ladder. The live source is the one place Devin states what an account may run: the
// model option a fresh ACP session offers (`devin models list` names every model Devin sells, a plan's or not). Asked of
// the first usable account, as Cursor's is: accounts on different plans see different lists, and a union would promise
// models the other cannot run. The floor is the account's own pick, which a turn sends as no choice at all.

// Not a Devin model: the catalog's floor before any account has answered. A turn on it leaves the session's own model.
export const DEVIN_OWN_PICK = "default";

// One row as the session offered it; `current` marks the account's own default, and `efforts` the reasoning depths the
// session's `thought_level` option offered on the shared ladder. Only the current model's are known: the option is
// stated for the model the session runs on, and the probe switches to no other.
export interface OfferedModel extends ModelChoice {
    readonly current?: boolean;
    readonly efforts?: readonly string[];
}

export interface DevinCatalog {
    // Never empty; models plus the default id.
    readonly models: () => Promise<{ models: Model[]; default: string }>;
    // Drops the cached answer, for an account connected or forgotten: the first account decides the list.
    readonly forget: () => void;
}

// A session's options are cheap to read but cost a process and a session each time; a plan changes rarely.
const MODELS_TTL_MS = 10 * 60_000;

const SEED: readonly OfferedModel[] = [{ value: DEVIN_OWN_PICK, name: "Devin's default", current: true }];

const toModel = (offered: OfferedModel): Model => ({
    id: offered.value,
    label: offered.name,
    ...(offered.description !== undefined ? { description: offered.description } : {}),
    ...opt("efforts", offered.efforts !== undefined && offered.efforts.length > 0 ? [...offered.efforts] : undefined),
});

// Rendered the same from a live answer and from the file: what Devin offered, its own default first among equals.
export const devinCatalogOf = (offered: readonly OfferedModel[]): { models: Model[]; default: string } => ({
    models: offered.map(toModel),
    default: offered.find((entry) => entry.current === true)?.value ?? offered[0]?.value ?? DEVIN_OWN_PICK,
});

const parseStored = (raw: unknown): OfferedModel[] | undefined =>
    Array.isArray(raw)
        ? raw.flatMap((entry: unknown) => {
              if (typeof entry !== "object" || entry === null) {
                  return [];
              }
              const { value, name, description, current, efforts } = entry as Record<string, unknown>;
              const tiers = Array.isArray(efforts) ? efforts.filter((effort): effort is string => typeof effort === "string") : [];
              return typeof value === "string" && typeof name === "string"
                  ? [
                        {
                            value,
                            name,
                            ...opt("description", typeof description === "string" ? description : undefined),
                            ...opt("current", current === true ? true : undefined),
                            ...opt("efforts", tiers.length > 0 ? tiers : undefined),
                        },
                    ]
                  : [];
          })
        : undefined;

export interface DevinCatalogDeps {
    readonly store: DevinStore;
    // Late-bound: the pool is built after the provider slices.
    readonly connections: () => AcpConnections;
    readonly persistPath: string;
    // An empty directory the probe session stands in, so Devin reads nothing of the workspace to answer a list.
    readonly probeDir: string;
}

export const createDevinCatalog = (deps: DevinCatalogDeps): DevinCatalog => {
    const discover = async (): Promise<OfferedModel[]> => {
        const [binary, account] = await Promise.all([devinCli(), liveDevinAccounts(deps.store).then((accounts) => accounts[0])]);
        if (binary === undefined || account === undefined) {
            return [];
        }
        try {
            await mkdir(deps.probeDir, { recursive: true });
            // The account's own warm process, the one its turns use, so the list costs no second sign-in.
            const connection = await deps.connections().acquire(devinAgentId(account.id), devinLaunch(binary, account.apiKey), deps.probeDir);
            const created = await connection.agent.request(methods.agent.session.new, { cwd: deps.probeDir, mcpServers: [] });
            if (connection.capabilities.sessionCapabilities?.delete != null) {
                // Nobody resumes a probe, so it leaves Devin's own session list as soon as it has answered.
                void connection.agent
                    .request(methods.agent.session.delete, { sessionId: created.sessionId })
                    .catch((error: unknown) => deps.store.logger.warn({ err: error }, "devin: could not delete the model probe's session"));
            }
            const models = sessionModelsOf(created.configOptions);
            // As of CLI 3000.11.3 Devin offers no `thought_level` option (DEVIN.effort stays false); read anyway, so the
            // day it does the catalog already says which depths the account's default takes.
            const thoughts = sessionThoughtsOf(created.configOptions);
            const efforts = thoughts === undefined ? [] : thoughtTiers(thoughts);
            return models === undefined
                ? []
                : models.choices.map((choice) =>
                      choice.value === models.current ? { ...choice, current: true, ...opt("efforts", efforts.length > 0 ? efforts : undefined) } : choice,
                  );
        } catch (error) {
            deps.store.logger.warn({ err: error }, "devin: model discovery failed, serving the last-known-good list");
            return [];
        }
    };
    const catalog = discoveredCatalog({
        ttlMs: MODELS_TTL_MS,
        discover,
        idOf: (offered) => offered.value,
        store: cacheFile<OfferedModel[]>(deps.persistPath, { parse: parseStored, fallback: () => [] }),
        toStored: (offered) => [...offered],
        seed: SEED,
        fromLive: devinCatalogOf,
        fromStored: devinCatalogOf,
    });
    return { models: catalog.models, forget: catalog.forget };
};
