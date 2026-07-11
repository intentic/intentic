import type { Provider } from "@intentic/engine";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import { createComposeServiceProvider, SERVICE_LOGGING, serviceSchema } from "./compose-service.js";

const outlineSchema = serviceSchema.extend({
    // Outline has no local password auth (only OIDC/SAML or SMTP magic links), so the stack bundles Dex as
    // its OIDC provider with ONE static user: the intentic admin identity. Dex's login form must be browser-
    // reachable, hence the second public hostname (authDomain = auth.<domain>, routed by the resolver).
    // ponytail: single static Dex user; upgrade path is pointing the OIDC_* env at a real IdP.
    authDomain: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    outlineImage: z.string(),
    postgresImage: z.string(),
    valkeyImage: z.string(),
    dexImage: z.string(),
});
type OutlineInputs = z.infer<typeof outlineSchema>;

// 3000 is Forgejo's host port, so Outline publishes on 3210; Dex on its stock 5556.
const PORT = 3210;
const DEX_PORT = 5556;

// Outline + its postgres/valkey backing + the Dex OIDC provider. TLS terminates at Cloudflare, so
// FORCE_HTTPS stays off while URL advertises the public https origin. Compose interpolates the ${…}
// references from the write-once .env in the project directory, so no secret lands in this file.
const composeYaml = (parsed: OutlineInputs, id: string, hash: string): string =>
    [
        "services:",
        "  postgres:",
        `    image: ${parsed.postgresImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    environment:",
        "      - POSTGRES_USER=outline",
        "      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}",
        "      - POSTGRES_DB=outline",
        "    volumes: [ pgdata:/var/lib/postgresql ]",
        "    healthcheck:",
        '      test: [ CMD-SHELL, "pg_isready -U outline" ]',
        "      interval: 10s",
        "      timeout: 5s",
        "      retries: 6",
        "  redis:",
        `    image: ${parsed.valkeyImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "  dex:",
        `    image: ${parsed.dexImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        `    ports: [ "${DEX_PORT}:5556" ]`,
        "    environment:",
        "      - OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}",
        "    volumes:",
        // The dex image's entrypoint serves /etc/dex/config.docker.yaml, so the config mounts onto that path.
        "      - ./dex-config.yaml:/etc/dex/config.docker.yaml:ro",
        "      - dexdata:/var/dex",
        "  outline:",
        `    image: ${parsed.outlineImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    depends_on:",
        "      postgres: { condition: service_healthy }",
        "      redis: { condition: service_started }",
        "      dex: { condition: service_started }",
        `    ports: [ "${PORT}:3000" ]`,
        "    environment:",
        `      - URL=https://${parsed.domain}`,
        "      - PORT=3000",
        "      - SECRET_KEY=${SECRET_KEY}",
        "      - UTILS_SECRET=${UTILS_SECRET}",
        "      - DATABASE_URL=postgres://outline:${POSTGRES_PASSWORD}@postgres:5432/outline",
        "      - PGSSLMODE=disable",
        "      - REDIS_URL=redis://redis:6379",
        "      - FILE_STORAGE=local",
        "      - FILE_STORAGE_LOCAL_ROOT_DIR=/var/lib/outline/data",
        "      - FORCE_HTTPS=false",
        "      - OIDC_CLIENT_ID=outline",
        "      - OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}",
        `      - OIDC_AUTH_URI=https://${parsed.authDomain}/auth`,
        `      - OIDC_TOKEN_URI=https://${parsed.authDomain}/token`,
        `      - OIDC_USERINFO_URI=https://${parsed.authDomain}/userinfo`,
        "      - OIDC_USERNAME_CLAIM=email",
        "      - OIDC_DISPLAY_NAME=intentic",
        "    volumes: [ outlinedata:/var/lib/outline/data ]",
        `    labels: [ "intentic.id=${id}", "intentic.type=outline", "intentic.hash=${hash}" ]`,
        "volumes: { pgdata: {}, dexdata: {}, outlinedata: {} }",
        "",
    ].join("\n");

// Dex: sqlite storage, one static OAuth client (Outline's callback) whose secret comes from the .env, and
// one static password user. The bcrypt hash is inlined here (not via .env/compose ${…}) because this config
// is rewritten every apply from the CURRENT OUTLINE_ADMIN_PASSWORD, so the login always matches the printed
// password — whereas the write-once .env would freeze a stale hash if the secret store were regenerated.
// The first OIDC sign-in to a fresh Outline becomes its admin.
const dexConfigYaml = (parsed: OutlineInputs): string =>
    [
        `issuer: https://${parsed.authDomain}`,
        "storage:",
        "  type: sqlite3",
        "  config: { file: /var/dex/dex.db }",
        "web:",
        "  http: 0.0.0.0:5556",
        "oauth2:",
        "  skipApprovalScreen: true",
        "staticClients:",
        "  - id: outline",
        "    name: Outline",
        `    redirectURIs: [ "https://${parsed.domain}/auth/oidc.callback" ]`,
        "    secretEnv: OIDC_CLIENT_SECRET",
        "enablePasswordDB: true",
        "staticPasswords:",
        `  - email: ${parsed.adminUser}`,
        // YAML double-quotes do no interpolation and the config rides a quoted heredoc, so the $-laden
        // bcrypt hash lands literally — no compose ${…} round-trip to mangle it.
        `    hash: "${bcrypt.hashSync(parsed.adminPassword, 10)}"`,
        "    username: intentic",
        "    userID: intentic-admin",
        "",
    ].join("\n");

// Outline (team wiki). /_health answers 200 once migrations ran and the server is up. Every .env secret is
// generated host-side (openssl rand); the admin password's bcrypt hash rides dex-config.yaml instead (see
// dexConfigYaml), so nothing here needs the resolved password.
export const createOutlineProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createComposeServiceProvider(
        {
            kind: "outline",
            schema: outlineSchema,
            port: PORT,
            healthPath: "/_health",
            files: (parsed, id, hash) => ({ "compose.yaml": composeYaml(parsed, id, hash), "dex-config.yaml": dexConfigYaml(parsed) }),
            env: () => [{ key: "SECRET_KEY" }, { key: "UTILS_SECRET" }, { key: "POSTGRES_PASSWORD" }, { key: "OIDC_CLIENT_SECRET" }],
            images: (parsed) => ({
                postgres: parsed.postgresImage,
                redis: parsed.valkeyImage,
                dex: parsed.dexImage,
                outline: parsed.outlineImage,
            }),
            // ponytail: recreate dex each apply so it reloads the bind-mounted dex-config.yaml (whose admin
            // password hash tracks the current OUTLINE_ADMIN_PASSWORD); compose ignores bind-mount changes,
            // and dex is tiny so the churn is cheap.
            seed: async (session, _parsed, log) => {
                const result = await session.exec(
                    "docker compose -p outline --project-directory /opt/intentic/outline -f /opt/intentic/outline/compose.yaml up -d --force-recreate dex",
                );
                if (result.code !== 0) {
                    throw new Error(`failed to recreate outline dex: exited ${result.code}: ${result.stderr.trim()}`);
                }
                log("outline: recreated dex to load the current admin password hash");
            },
        },
        executor,
    );
