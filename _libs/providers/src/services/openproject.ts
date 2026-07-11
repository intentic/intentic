import type { Provider } from "@intentic/engine";
import { z } from "zod";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import { createComposeServiceProvider, SERVICE_LOGGING, serviceSchema } from "./compose-service.js";

const openprojectSchema = serviceSchema.extend({
    // OpenProject's admin login is the fixed username "admin" (the resolver catalog's adminLogin); the seed
    // env vars below set its password/mail on first boot only, so the identity rides the write-once .env.
    adminUser: z.string(),
    adminPassword: z.string(),
    openprojectImage: z.string(),
});
type OpenprojectInputs = z.infer<typeof openprojectSchema>;

const PORT = 8082;

// The all-in-one image (NOT -slim): it bundles postgres + memcached + web + worker under supervisord, so
// the stack is one container with the pgdata/assets volume pair. OPENPROJECT_HTTPS makes Rails generate
// https URLs behind the Cloudflare-terminated tunnel; HSTS stays off since the container itself serves http.
const composeYaml = (parsed: OpenprojectInputs, id: string, hash: string): string =>
    [
        "services:",
        "  openproject:",
        `    image: ${parsed.openprojectImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        `    ports: [ "${PORT}:80" ]`,
        // The secret key base + seed admin password live in the write-once .env (chmod 600), not here.
        "    env_file: ./.env",
        "    environment:",
        `      - OPENPROJECT_HOST__NAME=${parsed.domain}`,
        "      - OPENPROJECT_HTTPS=true",
        "      - OPENPROJECT_HSTS=false",
        `      - OPENPROJECT_SEED_ADMIN_USER_MAIL=admin@${parsed.domain}`,
        "      - OPENPROJECT_SEED_ADMIN_USER_NAME=intentic",
        "      - OPENPROJECT_SEED_ADMIN_USER_PASSWORD_RESET=false",
        "    volumes:",
        "      - pgdata:/var/openproject/pgdata",
        "      - assets:/var/openproject/assets",
        `    labels: [ "intentic.id=${id}", "intentic.type=openproject", "intentic.hash=${hash}" ]`,
        "volumes: { pgdata: {}, assets: {} }",
        "",
    ].join("\n");

// OpenProject (project management). First boot runs the full database migration + seed before the health
// endpoint answers, hence the 600s ready budget (read returning undefined while it migrates is the normal
// not-yet-created signal, not an error).
export const createOpenprojectProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createComposeServiceProvider(
        {
            kind: "openproject",
            schema: openprojectSchema,
            port: PORT,
            healthPath: "/health_checks/default",
            readyTimeoutMs: 600_000,
            files: (parsed, id, hash) => ({ "compose.yaml": composeYaml(parsed, id, hash) }),
            env: (parsed) => [{ key: "OPENPROJECT_SECRET_KEY_BASE" }, { key: "OPENPROJECT_SEED_ADMIN_USER_PASSWORD", value: parsed.adminPassword }],
            images: (parsed) => ({ openproject: parsed.openprojectImage }),
        },
        executor,
    );
