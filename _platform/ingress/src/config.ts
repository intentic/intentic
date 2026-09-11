import { repoRoot } from "@intentic/constants/node";
import { type ConfigDefinition, cliArgs, env, envFile, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { join } from "node:path";
import { z } from "zod";

// Root .env, found walking up to the workspace marker; a container has none, reads env only.
const rootEnv = join(repoRoot(import.meta.url), ".env");

// Ingress holds no credential that can create anything: it verifies a signature and forwards bytes.
// A compromised edge can read traffic it already carries, but cannot make a sandbox reachable or claim a name.
export const configSchema = z.object({
    ingress: z
        .object({
            // Platform's public Ed25519 key (SPKI PEM); gates tunnel registration, fatal if empty. INGRESS_PUBLIC_KEY.
            publicKey: z.string().default(``),
            port: z.coerce.number().int().positive().default(8080),
            // Binds every interface; TLS terminates in front of this and the process itself speaks plain HTTP.
            host: z.string().default(`0.0.0.0`),
            /* WHICH BUILD IS ACTUALLY RUNNING, baked into the image at build time (Dockerfile BUILD_ID, set by
             * docker-release.sh to the same content-addressed tag it pushes) and never set by the deployment.
             * INGRESS_BUILD.
             *
             * This exists because its absence cost a customer an evening. The edge is the one platform component
             * nothing rolled automatically: CI pushed `ingress:latest` and the Fly machines kept serving a build
             * from ten days earlier, which is invisible from outside a process whose /health said only `status`
             * and `tunnels`. Hosted sandboxes had moved to `fly-replay` in that window, the old edge had no
             * replay in it, and every hosted sandbox answered 502 at its own public name for five minutes and
             * then told its owner to start it over. Empty means a build that did not come from the release
             * script; deploy-ingress.sh compares this against the tag it just pushed and goes red on a
             * mismatch, so a push that does not land can no longer look like a deploy. */
            build: z.string().default(``),
            // Configures the cluster: one anycast address behind several machines, forwarding to whichever holds a
            // tunnel.
            // Instance's name to peers and /health; empty falls back to a machine id, else random. INGRESS_INSTANCE_ID.
            instanceId: z.string().default(``),
            // Static peer list, `host[:port[:internalPort]]` comma-separated, for a non-Fly deployment. INGRESS_PEERS.
            peers: z.string().default(``),
            // Address peers reach this instance at; empty means it routes but cannot advertise. INGRESS_ADVERTISE_HOST.
            advertiseHost: z.string().default(``),
            // Internal holds-protocol listener, apart from the public port. INGRESS_INTERNAL_PORT /
            // INGRESS_INTERNAL_HOST.
            internalPort: z.coerce.number().int().positive().default(8081),
            internalHost: z.string().default(``),
        })
        .prefault({}),
    // What Fly injects per machine; empty off Fly. FLY_APP_NAME / FLY_PRIVATE_IP / FLY_MACHINE_ID.
    fly: z
        .object({
            appName: z.string().default(``),
            privateIp: z.string().default(``),
            machineId: z.string().default(``),
        })
        .prefault({}),
    // Where to check whether a sandbox still exists (GET /api/reachability/<id>); empty disables the check.
    // Fails open when the platform is unreachable, since reachability must not depend on it being up. PLATFORM_URL.
    platform: z
        .object({
            url: z.string().default(``),
        })
        .prefault({}),
    // Hosted sandboxes the platform runs as Fly apps named `<prefix>-<sandbox id>`; matched by hostname and replayed
    // there directly.
    // Empty disables replay; set only on an edge in the same Fly org as the hosted apps. HOSTED_APP_PREFIX.
    hosted: z
        .object({
            appPrefix: z.string().default(``),
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
