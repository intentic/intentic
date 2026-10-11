import { mkdir } from "node:fs/promises";
import { methods } from "@agentclientprotocol/sdk";
import type { Model } from "@intentic/sandbox-contract";
import { discoveredCatalog } from "../../../agent/models/model-catalog.js";
import { cacheFile } from "../../../store/open-document.js";
import type { AcpConnections } from "../../acp/acp-connection.js";
import { type ModelChoice, sessionModelsOf } from "../../acp/acp-model.js";
import { type DevinStore, liveDevinAccounts } from "../accounts/devin-credentials.js";
import { devinAgentId, devinCli, devinLaunch } from "../devin-cli.js";

// Devin's model catalog on the shared ladder. The live source is the one place Devin states what an account may run: the
// model option a fresh ACP session offers (`devin models list` names every model Devin sells, a plan's or not). Asked of
// the first usable account, as Cursor's is: accounts on different plans see different lists, and a union would promise
// models the other cannot run. The floor is the account's own pick, which a turn sends as no choice at all.

// Not a Devin model: the catalog's floor before any account has answered. A turn on it leaves the session's own model.
export const DEVIN_OWN_PICK = "default";

// One row as the session offered it; `current` marks the account's own default.
export interface OfferedModel extends ModelChoice {
    readonly current?: boolean;
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
              const { value, name, description, current } = entry as Record<string, unknown>;
              return typeof value === "string" && typeof name === "string"
                  ? [{ value, name, ...(typeof description === "string" ? { description } : {}), ...(current === true ? { current } : {}) }]
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
                void connection.agent.request(methods.agent.session.delete, { sessionId: created.sessionId }).catch(() => undefined);
            }
            const models = sessionModelsOf(created.configOptions);
            return models === undefined
                ? []
                : models.choices.map((choice) => (choice.value === models.current ? { ...choice, current: true } : choice));
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
