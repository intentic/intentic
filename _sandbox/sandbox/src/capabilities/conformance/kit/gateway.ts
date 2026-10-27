import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { cliEnvOf, shellEnvOf } from "../../cli-env.js";
import type { ExtensionHost } from "../../extension-inventory/installed-extensions.js";
import { brokerOf } from "../../broker/broker-routes.js";
import { createGateway, type RuleAsk, type GatewayAnswer } from "../../broker/broker-gateway.js";
import { brokerSessionsFrom } from "../../broker/broker-session.js";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { CapabilityContribution } from "@intentic/extension-manifest";
import { nodeRequest } from "../../../system/tls/node-request.js";
import { listen } from "./http.js";

export const startGateway = async (options: {
    readonly host: ExtensionHost;
    readonly card: Capability;
    readonly spec: CapabilityContribution;
    readonly fetch?: typeof fetch;
    readonly ask?: (input: RuleAsk) => Promise<GatewayAnswer>;
}) => {
    const broker = brokerOf(options.spec);
    if (broker === undefined) {
        throw new Error(`${options.spec.id} declares no broker`);
    }
    const card = options.card;
    if (card.kind !== "cli") {
        throw new Error("conformance gateway requires a CLI card");
    }
    const randomKey = randomBytes(32);
    const sessions = brokerSessionsFrom(async () => randomKey);
    const handler = createGateway({
        sessions,
        card: async (id) => (id === card.id ? { config: card.config, broker, name: options.spec.catalog.name } : undefined),
        ownerRules: async () => undefined,
        hostGuards: async () => [],
        credentialGate: { check: async () => ({ allow: true }) },
        prompts: {
            canPark: () => true,
            passed: () => false,
            ask: options.ask ?? (async () => ({ allow: false, reason: "conformance denied this request" })),
        },
        used: () => {},
        fetch: options.fetch ?? fetch,
    });
    const server = await listen(createServer(getRequestListener(handler)));
    try {
        const env = shellEnvOf(
            await cliEnvOf(options.host, {
                gateway: { sessions, origin: server.origin, conversationId: "conformance" },
                delivery: async () => "gateway",
            }),
        );
        return { env, close: server.close };
    } catch (error) {
        await server.close();
        throw error;
    }
};

// Only named origins may leave the gateway in a fake world.
export const redirectedFetch = (origins: Readonly<Record<string, string>>): typeof fetch => {
    const redirected = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        // A Request carries its method, headers and body inside itself, which re-addressing by URL would silently drop.
        if (input instanceof Request) {
            throw new Error("redirectedFetch takes (url, init), not a Request");
        }
        const source = new URL(String(input));
        const destination = origins[source.origin];
        if (destination === undefined) {
            throw new Error(`fake world refused undeclared origin ${source.origin}`);
        }
        return fetch(`${destination}${source.pathname}${source.search}`, { ...init, redirect: "manual" });
    };
    return Object.assign(redirected, { preconnect: fetch.preconnect });
};

// The probe's node-request transport, re-addressed to the fake for the named origins only.
export const redirectedNodeRequest =
    (origins: Readonly<Record<string, string>>): typeof nodeRequest =>
    (url, options) => {
        const destination = origins[url.origin];
        if (destination === undefined) {
            throw new Error(`fake world refused undeclared probe origin ${url.origin}`);
        }
        return nodeRequest(new URL(`${destination}${url.pathname}${url.search}`), options);
    };
