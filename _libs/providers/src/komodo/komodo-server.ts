import { setTimeout as sleep } from "node:timers/promises";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";

const serverSchema = z.object({
    komodoUrl: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    serverName: z.string(),
});
type ServerInputs = z.infer<typeof serverSchema>;
const parse = (inputs: ResolvedInputs): ServerInputs => parseInputs(serverSchema, inputs, "komodo-server");

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

// A worker host registered as a Komodo Server. Periphery's outbound `connect_as` auto-registers the server
// when it connects to Core; this provider waits for that registration to appear, then reports it as existing.
// Pure assertion/gate: no write operations — the server is created by Periphery, not by this provider.
export const createKomodoServerProvider = (api: KomodoApi = komodoApi): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["komodoUrl"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        try {
            const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
            const servers = await api.listServers({ baseUrl: parsed.komodoUrl, jwt });
            const server = servers.find((s) => s.name === parsed.serverName);
            if (server === undefined) {
                return undefined;
            }
            return { outputs: { serverName: parsed.serverName } };
        } catch (error) {
            ctx.log(`komodo-server "${ctx.id}": Komodo not reachable, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        // Poll until Periphery's outbound connection registers the server in Core.
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        for (;;) {
            const jwt = await api.login({ baseUrl: parsed.komodoUrl, username: parsed.adminUser, password: parsed.adminPassword });
            const servers = await api.listServers({ baseUrl: parsed.komodoUrl, jwt });
            if (servers.some((s) => s.name === parsed.serverName)) {
                return { serverName: parsed.serverName };
            }
            if (Date.now() >= deadline) {
                throw new Error(
                    `komodo-server "${parsed.serverName}": Periphery did not register within ${POLL_TIMEOUT_MS}ms; ` +
                        `check that the periphery container on the worker host can reach ${parsed.komodoUrl}`,
                );
            }
            await sleep(POLL_INTERVAL_MS);
        }
    },
    delete: async (inputs, ctx) => {
        // The server in Komodo is managed by Periphery's connection; when Periphery is removed (its own
        // delete), the server goes offline. We do not delete the server entry in Komodo — it goes stale
        // harmlessly and can be cleaned up manually.
        ctx.log(`komodo-server "${ctx.id}": server entry left in Komodo (Periphery manages its lifecycle)`);
    },
});
