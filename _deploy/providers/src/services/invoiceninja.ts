import { randomBytes } from "node:crypto";
import type { Provider } from "@intentic/engine";
import { z } from "zod";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import { createComposeServiceProvider, SERVICE_LOGGING, serviceSchema } from "./compose-service.js";

const invoiceninjaSchema = serviceSchema.extend({
    // Seeds Invoice Ninja's first account from IN_USER_EMAIL/IN_PASSWORD; idempotent once an account exists.
    adminUser: z.string(),
    adminPassword: z.string(),
    invoiceninjaImage: z.string(),
    mariadbImage: z.string(),
    valkeyImage: z.string(),
});
type InvoiceninjaInputs = z.infer<typeof invoiceninjaSchema>;

// 8000/8080/8082 are taken by paperless/signoz/openproject.
const PORT = 8083;

// One image serves app/worker/scheduler, selected by LARAVEL_ROLE; they share the &env anchor and storage volume.
// TLS terminates at Cloudflare, so REQUIRE_HTTPS stays off while APP_URL is https; secrets ride env_file, not this
// file.
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

// /health answers 200 once first-boot migration and seeding finish; readyTimeoutMs is 600s to cover that.
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
                // APP_KEY needs a base64: prefixed 32-byte key; minted here since the standard generator only produces
                // hex.
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
