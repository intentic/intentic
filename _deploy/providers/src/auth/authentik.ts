import type { Provider } from "@intentic/engine";
import { z } from "zod";
import { backingSchema, createBackingProvider } from "../core/backing-provider.js";
import { stampLabels } from "../core/backing-ssh.js";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

const KIND = "authentik";

const authentikSchema = backingSchema.extend({
    domain: z.string(),
    secretKey: z.string(),
    bootstrapToken: z.string(),
    bootstrapPassword: z.string(),
    dbPassword: z.string(),
    pgImage: z.string(),
    redisImage: z.string(),
});
type AuthentikInputs = z.infer<typeof authentikSchema>;

const internalUrl = (parsed: AuthentikInputs): string => `http://${parsed.internalIp}:${parsed.publishPort}`;

// Authentik as a self-contained compose stack: its own Postgres + Redis (Valkey) + the server (HTTP, stamped
// intentic.id=<id>) + the worker. Image refs are the fully-pinned inputs inlined into the YAML so a bump
// recreates the changed service on the next `up -d`; the AUTHENTIK_* secrets are interpolated from the
// write-once .env beside it.
const composeYaml = (parsed: AuthentikInputs, id: string, hash: string): string =>
    [
        "services:",
        "  postgresql:",
        `    image: ${parsed.pgImage}`,
        "    restart: unless-stopped",
        "    environment: { POSTGRES_USER: authentik, POSTGRES_DB: authentik, POSTGRES_PASSWORD: $AUTHENTIK_POSTGRESQL__PASSWORD }",
        "    volumes: [ database:/var/lib/postgresql ]",
        "    healthcheck: { test: [ CMD-SHELL, pg_isready -U authentik ], interval: 10s, timeout: 5s, retries: 10 }",
        "  redis:",
        `    image: ${parsed.redisImage}`,
        "    restart: unless-stopped",
        '    command: [ "--save", "60", "1", "--loglevel", "warning" ]',
        "    volumes: [ redis:/data ]",
        '    healthcheck: { test: [ CMD-SHELL, "valkey-cli ping | grep -q PONG" ], interval: 10s, timeout: 5s, retries: 10 }',
        "  server:",
        `    image: ${parsed.image}`,
        "    restart: unless-stopped",
        "    command: server",
        "    env_file: ./.env",
        `    ports: [ "${parsed.publishPort}:9000" ]`,
        "    volumes: [ media:/media, templates:/templates ]",
        "    depends_on: { postgresql: { condition: service_healthy }, redis: { condition: service_healthy } }",
        stampLabels(KIND, id, hash, parsed.protect),
        "  worker:",
        `    image: ${parsed.image}`,
        "    restart: unless-stopped",
        "    command: worker",
        "    env_file: ./.env",
        "    volumes: [ media:/media, certs:/certs, templates:/templates, /var/run/docker.sock:/var/run/docker.sock ]",
        "    depends_on: { postgresql: { condition: service_healthy }, redis: { condition: service_healthy } }",
        "volumes: { database: {}, redis: {}, media: {}, certs: {}, templates: {} }",
        "",
    ].join("\n");

// An Authentik auth backing instance (i.want.auth). read returns the resource once the server answers its
// health endpoint (so a noop re-derives the deterministic url/issuerUrl/internalUrl); diff drives a server
// image-pin bump; apply is idempotent (compose up -d reconciles, the named volumes persist). Per-app OIDC
// clients are the authentik-client binding's job, over the API.
export const createAuthentikProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createBackingProvider(
        {
            kind: KIND,
            schema: authentikSchema,
            // Authentik runs DB migrations on first boot, so allow a generous readiness window.
            readyTimeoutMs: 300_000,
            outputs: (parsed) => ({
                url: `https://${parsed.domain}`,
                issuerUrl: `https://${parsed.domain}/application/o/`,
                internalUrl: internalUrl(parsed),
            }),
            files: (parsed, id, hash) => ({ "compose.yaml": composeYaml(parsed, id, hash) }),
            /* Write-once, and this one has four secrets in it: the signing key, the bootstrap credentials the
             * bindings reuse, and the database password. All four are baked in on first init, so re-keying the
             * file would break every session and lock the stack out of its own database. */
            env: (parsed) => [
                { key: "AUTHENTIK_POSTGRESQL__HOST", value: "postgresql" },
                { key: "AUTHENTIK_POSTGRESQL__USER", value: "authentik" },
                { key: "AUTHENTIK_POSTGRESQL__NAME", value: "authentik" },
                { key: "AUTHENTIK_REDIS__HOST", value: "redis" },
                { key: "AUTHENTIK_BOOTSTRAP_EMAIL", value: `akadmin@${parsed.domain}` },
                { key: "AUTHENTIK_SECRET_KEY", value: parsed.secretKey },
                { key: "AUTHENTIK_POSTGRESQL__PASSWORD", value: parsed.dbPassword },
                { key: "AUTHENTIK_BOOTSTRAP_PASSWORD", value: parsed.bootstrapPassword },
                { key: "AUTHENTIK_BOOTSTRAP_TOKEN", value: parsed.bootstrapToken },
            ],
            // Probe the server's health endpoint FROM THE HOST over SSH (it publishes 9000 on the host); it
            // answers 2xx once migrations are done and it is serving.
            probe: (parsed) => `wget -q -T 10 -O /dev/null ${internalUrl(parsed)}/-/health/ready/`,
        },
        executor,
    );
