import { pollUntil, type Provider, type ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs, sshSchema } from "../core/inputs.js";
import { overSsh } from "../core/over-ssh.js";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import type { KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";
import { KOMODO_CORE_PORT } from "./komodo.js";

// The ssh block is the CONTROL-PLANE host's (where Core runs), the registration check queries Core over an
// SSH port-forward, while Periphery on the worker still dials Core over its public route (cross-host).
const serverSchema = sshSchema.extend({
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
// Pure assertion/gate: no write operations, the server is created by Periphery, not by this provider.
export const createKomodoServerProvider = (api: KomodoApi = komodoApi, executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        try {
            return await overSsh(executor, parsed, KOMODO_CORE_PORT, async (baseUrl) => {
                const jwt = await api.login({ baseUrl, username: parsed.adminUser, password: parsed.adminPassword });
                const servers = await api.listServers({ baseUrl, jwt });
                const server = servers.find((s) => s.name === parsed.serverName);
                if (server === undefined) {
                    return undefined;
                }
                return { outputs: { serverName: parsed.serverName } };
            });
        } catch (error) {
            ctx.log(`komodo-server "${ctx.id}": Komodo not reachable, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        return overSsh(executor, parsed, KOMODO_CORE_PORT, async (baseUrl) => {
            // Poll until Periphery's outbound connection registers the server in Core.
            const registered = await pollUntil(
                async () => {
                    const jwt = await api.login({ baseUrl, username: parsed.adminUser, password: parsed.adminPassword });
                    const servers = await api.listServers({ baseUrl, jwt });
                    return servers.some((s) => s.name === parsed.serverName);
                },
                { timeoutMs: POLL_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
            );
            if (!registered) {
                throw new Error(
                    `komodo-server "${parsed.serverName}": Periphery did not register within ${POLL_TIMEOUT_MS}ms; ` +
                        "check that the periphery container on the worker host can reach Core's public deploy route",
                );
            }
            return { serverName: parsed.serverName };
        });
    },
    delete: async (inputs, ctx) => {
        // The server in Komodo is managed by Periphery's connection; when Periphery is removed (its own
        // delete), the server goes offline. We do not delete the server entry in Komodo, it goes stale
        // harmlessly and can be cleaned up manually.
        ctx.log(`komodo-server "${ctx.id}": server entry left in Komodo (Periphery manages its lifecycle)`);
    },
});
