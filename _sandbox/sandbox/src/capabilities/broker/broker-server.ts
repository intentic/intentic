import { createAdaptorServer } from "@hono/node-server";
import { BROKER_PORT } from "@intentic/constants";
import type { Logger } from "pino";
import { contributionFor, contributionRegistry } from "../contributions.js";
import type { Services } from "../../composition.js";
import { createGateway, type GatewayCard, type GatewayUse } from "./broker-gateway.js";
import { brokerOf } from "./broker-routes.js";

// The credential gateway's listener: the daemon's own socket on 127.0.0.1, beside netd rather than behind it, so nothing
// the tunnel or the published loopback port relays can ever reach it. An address it issued is therefore useful only to
// a process inside this container, which is the only place the agent's shell is.

// One ledger row per card and conversation a minute at most: the ledger is a "last used" for people, and a busy turn
// sends hundreds of requests a minute through one card.
const USE_RECORD_EVERY_MS = 60_000;

const gatewayCard =
    (services: Services) =>
    async (capability: string): Promise<GatewayCard | undefined> => {
        const card = (await services.capabilities.list()).find((entry) => entry.id === capability);
        if (card?.kind !== "cli") {
            return undefined;
        }
        const connector = contributionFor(await contributionRegistry(services), "cli", card.config);
        const broker = connector === undefined ? undefined : brokerOf(connector.spec);
        // A card the owner set to raw delivery holds its own credential: an address minted before the switch stops here.
        if (connector === undefined || broker === undefined || (await services.credentialPolicy.of(capability)).delivery === "raw") {
            return undefined;
        }
        return { config: card.config, broker, name: `${connector.spec.catalog.name} (${capability})` };
    };

const useRecorder = (services: Services): ((use: GatewayUse) => void) => {
    const last = new Map<string, number>();
    return (use) => {
        const now = Date.now();
        const key = `${use.capability}\u0000${use.conversationId ?? ""}`;
        if (use.approvedBy === undefined && now - (last.get(key) ?? 0) < USE_RECORD_EVERY_MS) {
            return;
        }
        last.set(key, now);
        for (const field of use.fields) {
            void services.secretUses
                .record({
                    name: `${use.capability}/${field}`,
                    lane: "gateway",
                    detail: use.detail,
                    ...(use.approvedBy !== undefined ? { approvedBy: use.approvedBy } : {}),
                    at: now,
                })
                .catch((error: unknown) => services.logger.warn({ err: error, capability: use.capability }, "credential gateway: use record failed"));
        }
    };
};

export interface CredentialGatewayHandle {
    readonly stop: () => Promise<void>;
}

/** Binds the gateway on loopback; a port already taken is a logged fault, and brokered cards then refuse rather than leak. */
export const startCredentialGateway = async (services: Services, logger: Logger, port: number = BROKER_PORT): Promise<CredentialGatewayHandle> => {
    const handle = createGateway({
        sessions: services.brokerSessions,
        card: gatewayCard(services),
        ownerRules: async (capability) => (await services.credentialPolicy.of(capability)).rules,
        hostGuards: services.hostGuards,
        credentialGate: services.credentialGate,
        prompts: services.rulePrompts,
        used: useRecorder(services),
    });
    const server = createAdaptorServer({ fetch: handle, hostname: "127.0.0.1", port });
    await new Promise<void>((resolve) => {
        server.once("error", (error) => {
            logger.error({ err: error, port }, "credential gateway: could not listen; brokered credentials are unavailable until restart");
            resolve();
        });
        server.listen(port, "127.0.0.1", () => resolve());
    });
    return {
        stop: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
    };
};
