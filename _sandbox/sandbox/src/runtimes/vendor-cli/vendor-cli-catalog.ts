import { mkdir } from "node:fs/promises";
import { methods } from "@agentclientprotocol/sdk";
import type { Model } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { z } from "zod";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import { opt } from "../../opt.js";
import { cacheFile } from "../../store/open-document.js";
import type { AcpConnection, AcpConnections } from "../acp/acp-connection.js";
import { sessionModelsOf, sessionThoughtsOf, thoughtTiers } from "../acp/acp-model.js";
import { type CliStore, liveCliAccounts } from "./vendor-cli-store.js";
import { cliAgentId, cliBinary, type VendorCli } from "./vendor-cli.js";

// A vendor CLI's model catalog on the shared ladder, read where the CLI states what an account may run: the `model`
// option a fresh ACP session offers, asked of the first usable account's own warm process (accounts on different plans
// see different lists, and a union would promise models the other cannot run). Each model's reasoning depths are the
// `thought_level` option the session offers once switched to it, so the probe walks the list: a switch is a local
// config change, never a model request. The floor is the CLI's own pick, which a turn sends as no choice at all.

// Not a model: the catalog's floor before any account has answered. A turn on it leaves the session's own model.
export const CLI_OWN_PICK = "default";

// Never empty; models plus the default id, as every provider's catalog answers.
export interface ProviderModels {
    readonly models: Model[];
    readonly default: string;
}

export interface CliCatalog {
    readonly models: () => Promise<ProviderModels>;
    // Drops the cached answer, for an account connected or forgotten: the first account decides the list.
    readonly forget: () => void;
}

// A session's options cost a process and a session each time; a plan changes rarely.
const MODELS_TTL_MS = 10 * 60_000;

const toModel = (offered: OfferedModel): Model => ({
    id: offered.value,
    label: offered.name,
    ...opt("description", offered.description),
    ...opt("efforts", offered.efforts !== undefined && offered.efforts.length > 0 ? [...offered.efforts] : undefined),
});

// Rendered the same from a live answer and from the file: what the CLI offered, its own default first among equals.
export const cliCatalogOf = (offered: readonly OfferedModel[]): ProviderModels => ({
    models: offered.map(toModel),
    default: offered.find((entry) => entry.current === true)?.value ?? offered[0]?.value ?? CLI_OWN_PICK,
});

// What the file keeps per model, read back through its own shape so a stale or foreign file reads as nothing kept.
const OfferedModelSchema = z.object({
    value: z.string(),
    name: z.string(),
    description: z.string().optional(),
    current: z.literal(true).optional(),
    efforts: z.array(z.string()).optional(),
});
// One row as the session offered it; `current` marks the account's own default, `efforts` the depths it offers.
export type OfferedModel = z.infer<typeof OfferedModelSchema>;

// The depths a session offers for the model it is on, on the shared ladder; none where it offers no `thought_level`.
const effortsOf = (options: Parameters<typeof sessionThoughtsOf>[0]): string[] => {
    const thoughts = sessionThoughtsOf(options);
    return thoughts === undefined ? [] : thoughtTiers(thoughts);
};

// Every model the probe session offers, each with the depths it offers once the session is switched to it. A model the
// CLI refuses to switch to keeps no efforts rather than failing the list.
export const offeredModels = async (
    connection: Pick<AcpConnection, "agent">,
    sessionId: string,
    options: Parameters<typeof sessionModelsOf>[0],
): Promise<OfferedModel[]> => {
    const models = sessionModelsOf(options);
    if (models === undefined) {
        return [];
    }
    const offered: OfferedModel[] = [];
    for (const choice of models.choices) {
        const efforts =
            choice.value === models.current
                ? effortsOf(options)
                : // one session, switched model by model
                  await connection.agent
                      .request(methods.agent.session.setConfigOption, { sessionId, configId: models.configId, value: choice.value })
                      .then(
                          (answer) => effortsOf(answer.configOptions),
                          (): string[] => [],
                      );
        offered.push({
            ...choice,
            ...opt("current", choice.value === models.current ? true : undefined),
            ...opt("efforts", efforts.length > 0 ? efforts : undefined),
        });
    }
    return offered;
};

export interface CliCatalogDeps {
    readonly cli: VendorCli;
    readonly store: CliStore;
    // Late-bound: the pool is built after the provider slices.
    readonly connections: () => AcpConnections;
    readonly persistPath: string;
    // An empty directory the probe session stands in, so the CLI reads nothing of the workspace to answer a list.
    readonly probeDir: string;
}

export const createCliCatalog = ({ cli, store, connections, persistPath, probeDir }: CliCatalogDeps): CliCatalog => {
    const discover = async (): Promise<OfferedModel[]> => {
        const [binary, account] = await Promise.all([cliBinary(cli), liveCliAccounts(store).then((accounts) => accounts[0])]);
        if (binary === undefined || account === undefined) {
            return [];
        }
        try {
            await mkdir(probeDir, { recursive: true });
            const launch = cli.launch(binary, store.homeOf(account.id));
            // The account's own warm process, the one its turns use, so the list costs no second sign-in.
            const connection = await connections().acquire(cliAgentId(cli, account.id), launch, probeDir);
            const created = await connection.agent.request(methods.agent.session.new, {
                cwd: probeDir,
                mcpServers: [],
                ...opt("_meta", launch.sessionMeta === undefined ? undefined : { ...launch.sessionMeta }),
            });
            const offered = await offeredModels(connection, created.sessionId, created.configOptions);
            // Nobody resumes a probe, so it leaves the CLI's own session list as soon as it has answered.
            const capabilities = connection.capabilities.sessionCapabilities;
            const leave =
                capabilities?.delete != null ? methods.agent.session.delete : capabilities?.close != null ? methods.agent.session.close : undefined;
            if (leave !== undefined) {
                void connection.agent.request(leave, { sessionId: created.sessionId }).then(
                    () => undefined,
                    (error: Error) => store.logger.warn({ err: error }, `${cli.runtime}: could not end the model probe's session`),
                );
            }
            return offered;
        } catch (error) {
            store.logger.warn({ err: error }, `${cli.runtime}: model discovery failed, serving the last-known-good list`);
            return [];
        }
    };
    const catalog = discoveredCatalog({
        ttlMs: MODELS_TTL_MS,
        discover,
        idOf: (offered) => offered.value,
        store: cacheFile<OfferedModel[]>(persistPath, { parse: (raw) => z.array(OfferedModelSchema).safeParse(raw).data, fallback: () => [] }),
        toStored: (offered) => [...offered],
        seed: [{ value: CLI_OWN_PICK, name: `${cli.name}'s default`, current: true }],
        fromLive: cliCatalogOf,
        fromStored: cliCatalogOf,
    });
    return { models: catalog.models, forget: catalog.forget };
};
