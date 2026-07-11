import { randomBytes } from "node:crypto";
import type { Provider } from "@intentic/engine";
import { z } from "zod";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import { createComposeServiceProvider, SERVICE_LOGGING, serviceSchema } from "./compose-service.js";

const infisicalSchema = serviceSchema.extend({
    // Infisical has no env-based admin seeding — its first completed signup becomes the instance admin,
    // which on a routed public domain is an ownership race. The seed hook below claims the instance for the
    // intentic admin identity through Infisical's one-shot bootstrap API instead.
    adminUser: z.string(),
    adminPassword: z.string(),
    infisicalImage: z.string(),
    postgresImage: z.string(),
    valkeyImage: z.string(),
});
type InfisicalInputs = z.infer<typeof infisicalSchema>;

// 8080 is SigNoz's host port, so Infisical publishes on 8084 (container-side it serves 8080).
const PORT = 8084;

// The standalone image (frontend + backend in one; DB migrations run on boot, so no migrator container)
// with its postgres/valkey backing. TLS terminates at Cloudflare, so SITE_URL advertises the public https
// origin while the container serves plain http. Compose interpolates the ${…} references from the
// write-once .env in the project directory, so no secret lands in this file.
const composeYaml = (parsed: InfisicalInputs, id: string, hash: string): string =>
    [
        "services:",
        "  postgres:",
        `    image: ${parsed.postgresImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    environment:",
        "      - POSTGRES_USER=infisical",
        "      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}",
        "      - POSTGRES_DB=infisical",
        "    volumes: [ pgdata:/var/lib/postgresql ]",
        "    healthcheck:",
        '      test: [ CMD-SHELL, "pg_isready -U infisical" ]',
        "      interval: 10s",
        "      timeout: 5s",
        "      retries: 6",
        "  redis:",
        `    image: ${parsed.valkeyImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "  infisical:",
        `    image: ${parsed.infisicalImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    depends_on:",
        "      postgres: { condition: service_healthy }",
        "      redis: { condition: service_started }",
        `    ports: [ "${PORT}:8080" ]`,
        "    environment:",
        "      - ENCRYPTION_KEY=${ENCRYPTION_KEY}",
        "      - AUTH_SECRET=${AUTH_SECRET}",
        "      - DB_CONNECTION_URI=postgres://infisical:${POSTGRES_PASSWORD}@postgres:5432/infisical",
        "      - REDIS_URL=redis://redis:6379",
        `      - SITE_URL=https://${parsed.domain}`,
        "      - TELEMETRY_ENABLED=false",
        `    labels: [ "intentic.id=${id}", "intentic.type=infisical", "intentic.hash=${hash}" ]`,
        "volumes: { pgdata: {} }",
        "",
    ].join("\n");

// Infisical (secrets management). /api/status answers 200 once migrations ran and the server is up.
export const createInfisicalProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createComposeServiceProvider(
        {
            kind: "infisical",
            schema: infisicalSchema,
            port: PORT,
            healthPath: "/api/status",
            files: (parsed, id, hash) => ({ "compose.yaml": composeYaml(parsed, id, hash) }),
            env: () => [
                // Infisical validates ENCRYPTION_KEY as 16-byte hex and AUTH_SECRET as 32-byte base64 —
                // neither matches the host-side hex-32 generator, so both are minted here (the write-once
                // guard keeps the first apply's values).
                { key: "ENCRYPTION_KEY", value: randomBytes(16).toString("hex") },
                { key: "AUTH_SECRET", value: randomBytes(32).toString("base64") },
                { key: "POSTGRES_PASSWORD" },
            ],
            images: (parsed) => ({ postgres: parsed.postgresImage, redis: parsed.valkeyImage, infisical: parsed.infisicalImage }),
            // Claim the fresh instance's admin FROM THE HOST (the signoz seed-admin pattern). Idempotent
            // server-side: an initialized instance answers 400 "Instance has already been set up".
            seed: async (session, parsed, log) => {
                const body = JSON.stringify({ email: parsed.adminUser, password: parsed.adminPassword, organization: "intentic" });
                const result = await session.exec(
                    `curl -s -o /dev/null -w '%{http_code}' -X POST http://${parsed.internalIp}:${PORT}/api/v1/admin/bootstrap -H 'Content-Type: application/json' -d '${body}'`,
                );
                if (result.stdout.trim() !== "200") {
                    log(`infisical: bootstrap returned ${result.stdout.trim() || "no status"} (instance likely already initialized)`);
                }
            },
        },
        executor,
    );
