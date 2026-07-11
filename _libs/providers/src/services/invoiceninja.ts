import { randomBytes } from "node:crypto";
import type { Provider } from "@intentic/engine";
import { z } from "zod";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import { createComposeServiceProvider, SERVICE_LOGGING, serviceSchema } from "./compose-service.js";

const invoiceninjaSchema = serviceSchema.extend({
    // Invoice Ninja seeds its first account from IN_USER_EMAIL/IN_PASSWORD on first boot (idempotent: the
    // entrypoint skips it once an account exists), so the intentic admin identity rides the write-once .env.
    adminUser: z.string(),
    adminPassword: z.string(),
    invoiceninjaImage: z.string(),
    mariadbImage: z.string(),
    valkeyImage: z.string(),
});
type InvoiceninjaInputs = z.infer<typeof invoiceninjaSchema>;

// 8000/8080/8082 are taken (paperless/signoz/openproject), so Invoice Ninja publishes on 8083.
const PORT = 8083;

// The Octane/FrankenPHP image is self-serving (the -debian variant is php-fpm behind an nginx sidecar); one
// image runs three roles — the entrypoint picks the artisan command from LARAVEL_ROLE, so app/worker/
// scheduler share the &env anchor, the .env secrets and the storage volume. --port=80 matches the image's
// baked healthcheck (curl http://localhost/health). MySQL/MariaDB only (no Postgres); cache/queue/session
// ride the redis-compatible valkey. TLS terminates at Cloudflare, so REQUIRE_HTTPS stays off while APP_URL
// advertises the public https origin. APP_KEY/DB_PASSWORD/IN_PASSWORD reach the containers via env_file,
// so no secret lands in this file.
const composeYaml = (parsed: InvoiceninjaInputs, id: string, hash: string): string =>
    [
        "x-env: &env",
        `  APP_URL: https://${parsed.domain}`,
        "  APP_ENV: production",
        '  APP_DEBUG: "false"',
        '  REQUIRE_HTTPS: "false"',
        '  TRUSTED_PROXIES: "*"',
        "  CACHE_DRIVER: redis",
        "  QUEUE_CONNECTION: redis",
        "  SESSION_DRIVER: redis",
        "  REDIS_HOST: redis",
        '  REDIS_PORT: "6379"',
        "  DB_CONNECTION: mysql",
        "  DB_HOST: mariadb",
        '  DB_PORT: "3306"',
        "  DB_DATABASE: ninja",
        "  DB_USERNAME: ninja",
        `  IN_USER_EMAIL: ${parsed.adminUser}`,
        '  IS_DOCKER: "true"',
        "  MAIL_MAILER: log",
        "services:",
        "  mariadb:",
        `    image: ${parsed.mariadbImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    environment:",
        "      - MARIADB_DATABASE=ninja",
        "      - MARIADB_USER=ninja",
        "      - MARIADB_PASSWORD=${DB_PASSWORD}",
        "      - MARIADB_ROOT_PASSWORD=${DB_ROOT_PASSWORD}",
        "    volumes: [ mariadbdata:/var/lib/mysql ]",
        "    healthcheck:",
        "      test: [ CMD, healthcheck.sh, --connect, --innodb_initialized ]",
        "      interval: 10s",
        "      timeout: 5s",
        "      retries: 6",
        "  redis:",
        `    image: ${parsed.valkeyImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "  app:",
        `    image: ${parsed.invoiceninjaImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    command: --port=80 --workers=2",
        "    depends_on:",
        "      mariadb: { condition: service_healthy }",
        "      redis: { condition: service_started }",
        `    ports: [ "${PORT}:80" ]`,
        "    env_file: ./.env",
        "    environment:",
        "      <<: *env",
        "      LARAVEL_ROLE: app",
        "    volumes: [ appstorage:/app/storage ]",
        `    labels: [ "intentic.id=${id}", "intentic.type=invoiceninja", "intentic.hash=${hash}" ]`,
        "  worker:",
        `    image: ${parsed.invoiceninjaImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    command: --sleep=3 --tries=3 --max-time=3600",
        "    depends_on:",
        "      app: { condition: service_healthy }",
        "    env_file: ./.env",
        "    environment:",
        "      <<: *env",
        "      LARAVEL_ROLE: worker",
        "    volumes: [ appstorage:/app/storage ]",
        "  scheduler:",
        `    image: ${parsed.invoiceninjaImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    command: --verbose",
        "    depends_on:",
        "      app: { condition: service_healthy }",
        "    env_file: ./.env",
        "    environment:",
        "      <<: *env",
        "      LARAVEL_ROLE: scheduler",
        "    volumes: [ appstorage:/app/storage ]",
        "volumes: { mariadbdata: {}, appstorage: {} }",
        "",
    ].join("\n");

// Invoice Ninja (invoicing). /health answers 200 once migrated and serving; the first boot runs the full
// Laravel migration + seed before that, hence the 600s ready budget (the openproject pattern).
export const createInvoiceninjaProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createComposeServiceProvider(
        {
            kind: "invoiceninja",
            schema: invoiceninjaSchema,
            port: PORT,
            healthPath: "/health",
            readyTimeoutMs: 600_000,
            files: (parsed, id, hash) => ({ "compose.yaml": composeYaml(parsed, id, hash) }),
            env: (parsed) => [
                // Laravel requires the "base64:" key form (32 bytes), which the host-side hex generator can't
                // produce — minted here; the write-once guard keeps the first apply's value (the outline
                // bcrypt-hash pattern).
                { key: "APP_KEY", value: `base64:${randomBytes(32).toString("base64")}` },
                { key: "DB_PASSWORD" },
                { key: "DB_ROOT_PASSWORD" },
                { key: "IN_PASSWORD", value: parsed.adminPassword },
            ],
            images: (parsed) => ({
                mariadb: parsed.mariadbImage,
                redis: parsed.valkeyImage,
                app: parsed.invoiceninjaImage,
                worker: parsed.invoiceninjaImage,
                scheduler: parsed.invoiceninjaImage,
            }),
        },
        executor,
    );
