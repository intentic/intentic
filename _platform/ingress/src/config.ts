import { repoRoot } from "@intentic/constants/node";
import { type ConfigDefinition, cliArgs, env, envFile, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { join } from "node:path";
import { z } from "zod";

// Root .env, found by walking up to the workspace marker, so a developer running this beside the api picks up
// the same file. A deployed container has none and every value comes from the environment.
const rootEnv = join(repoRoot(import.meta.url), ".env");

/* THE EDGE'S WHOLE CONFIGURATION, and the short list is the point.
 *
 * The ingress holds NO credential that can create anything. It verifies a signature and it forwards bytes; the
 * platform is the only party that can mint a grant, and revoking one is deleting the sandbox row. So a
 * compromised edge can read the traffic it is already carrying and can do nothing else — it cannot make a
 * sandbox reachable, cannot claim a name, and has no admin API to be stolen. That is the difference from the
 * hub this replaced, whose admin token could mint accounts for anybody.
 */
export const configSchema = z.object({
    ingress: z
        .object({
            /* The PUBLIC half of the platform's Ed25519 pair (SPKI PEM), and the only thing that decides
             * whether a tunnel may register. Empty is fatal rather than permissive: an edge that cannot verify
             * would either refuse every sandbox or, far worse, be tempted to accept them, and there is no
             * useful third behavior. INGRESS_PUBLIC_KEY. */
            publicKey: z.string().default(``),
            port: z.coerce.number().int().positive().default(8080),
            // Binds every interface: TLS terminates in front of this (Fly's edge, or a proxy) and the process
            // itself speaks plain HTTP.
            host: z.string().default(`0.0.0.0`),
            /* THE CLUSTER, which is several of this process behind one anycast address (cluster.ts). A tunnel
             * lands on ONE machine and a browser on whichever is nearest IT, so every machine has to be able to
             * hand a request to the one holding the tunnel. Nothing here is required: no peers means one
             * machine, which is exactly the process this was before it could have peers. */
            // How this instance names itself to its peers, in logs and on /health. INGRESS_INSTANCE_ID; empty
            // falls back to Fly's machine id, then to a random one for the process's life (main.ts).
            instanceId: z.string().default(``),
            /* A static peer list, `host[:port[:internalPort]]` comma-separated, for a deployment that is not on
             * Fly (compose across hosts, a test). Ports default to this instance's own, since every instance
             * runs the same image with the same env. On Fly leave this empty: the app's internal DNS lists
             * every machine and is polled instead (peers.ts). INGRESS_PEERS. */
            peers: z.string().default(``),
            /* The address THIS instance tells its peers to reach it at. On Fly it is the private address and
             * needs no setting; with a static list it is whatever the other hosts know this one as. Empty with
             * peers configured means this machine routes and forwards but cannot say what it holds, which
             * main.ts warns about at boot. INGRESS_ADVERTISE_HOST. */
            advertiseHost: z.string().default(``),
            /* The holds protocol's own listener, separate from the public port so it can be bound to a private
             * address: Fly's 6PN on Fly (unreachable from the internet by construction), and simply never
             * published in compose. INGRESS_INTERNAL_PORT / INGRESS_INTERNAL_HOST; an empty host binds the
             * Fly private address when there is one and every interface otherwise. */
            internalPort: z.coerce.number().int().positive().default(8081),
            internalHost: z.string().default(``),
        })
        .prefault({}),
    /* What Fly injects into every machine, read as-is: the app name is what internal DNS is asked about
     * (`<app>.internal` answers every machine's private address), the private address is how this instance
     * recognises itself in that answer and what its internal listener binds, and the machine id is its name.
     * All empty off Fly, and the cluster then runs on INGRESS_PEERS or on nobody. FLY_APP_NAME /
     * FLY_PRIVATE_IP / FLY_MACHINE_ID. */
    fly: z
        .object({
            appName: z.string().default(``),
            privateIp: z.string().default(``),
            machineId: z.string().default(``),
        })
        .prefault({}),
    /* Where to ask whether a sandbox still exists (GET /api/reachability/<id>). Empty ⇒ that check is off and
     * every validly-signed grant registers, which is the right shape for a local run and for a deployment
     * standing the edge up before the platform knows about it.
     *
     * The check FAILS OPEN by design when the platform is unreachable — see revocation.ts. Reachability must
     * not depend on the platform being up; that is the whole reason the platform is off the hot path.
     * PLATFORM_URL. */
    platform: z
        .object({
            url: z.string().default(``),
        })
        .prefault({}),
    log: z
        .object({
            level: z.enum([`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`]).default(`info`),
            pretty: z.stringbool().default(process.env[`NODE_ENV`] !== `production`),
        })
        .prefault({}),
});

// Merge order (later wins): .env file < process env < CLI args.
const definition = {
    schema: configSchema,
    sources: [envFile(rootEnv), env(), cliArgs()],
} satisfies ConfigDefinition<typeof configSchema>;

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (): Config => loadPuristicConfig(definition);
