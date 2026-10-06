import type { Provider } from "@intentic/engine";
import { z } from "zod";
import type { EnvEntry } from "../core/host-files.js";
import { gitProvider } from "../core/inputs.js";
import type { SshExecutor } from "../core/ssh.js";
import { type ContainerStamp, stampLabels } from "../core/stamp.js";
import { createComposeServiceProvider, serviceSchema } from "../services/compose-service.js";

const komodoSchema = serviceSchema.extend({
    adminUser: z.string(),
    adminPassword: z.string(),
    // Git provider for cloning private repos, Forgejo stack only; gitUrl is Forgejo's internal url.
    gitUrl: z.string().optional(),
    gitAccount: z.string().optional(),
    gitToken: z.string().optional(),
    // Container registry Komodo pulls app images from, written as a [[docker_registry]] account.
    registry: z.string(),
    registryUser: z.string(),
    registryToken: z.string(),
    // Fully-pinned images for the four compose services, written into compose.yaml so a bump recreates on apply.
    coreImage: z.string(),
    peripheryImage: z.string(),
    ferretdbImage: z.string(),
    postgresImage: z.string(),
    // Guarded-update inputs, present only under updatePolicy:"guarded" with a backup.
    guardRepo: z.string().optional(),
    resticImage: z.string().optional(),
});
type KomodoInputs = z.infer<typeof komodoSchema>;

const CORE = "intentic-komodo-core";
// The fixed host port Core publishes, the port every engine-side Komodo consumer forwards to over SSH.
export const KOMODO_CORE_PORT = 9120;
// Each compose service's desired pinned image, so diff can report exactly which one drifted.
const desiredImages = (parsed: KomodoInputs): Record<string, string> => ({
    postgres: parsed.postgresImage,
    ferretdb: parsed.ferretdbImage,
    core: parsed.coreImage,
    periphery: parsed.peripheryImage,
});

// FerretDB + Core + Periphery, co-located so Periphery trusts Core via the shared keys volume. `$...` secrets
// interpolate from the .env beside it; image refs are inlined here (not the .env) so a bump recreates on `up -d`.
const composeYaml = (images: Record<string, string>, stamp: ContainerStamp): string =>
    [
        "services:",
        "  postgres:",
        `    image: ${images["postgres"]}`,
        "    restart: unless-stopped",
        "    environment: { POSTGRES_USER: $KOMODO_DATABASE_USERNAME, POSTGRES_PASSWORD: $KOMODO_DATABASE_PASSWORD, POSTGRES_DB: postgres }",
        "    volumes: [ postgres-data:/var/lib/postgresql/data ]",
        "  ferretdb:",
        `    image: ${images["ferretdb"]}`,
        "    restart: unless-stopped",
        "    depends_on: [ postgres ]",
        "    environment: { FERRETDB_POSTGRESQL_URL: postgres://$KOMODO_DATABASE_USERNAME:$KOMODO_DATABASE_PASSWORD@postgres:5432/postgres }",
        "    volumes: [ ferretdb-state:/state ]",
        "  core:",
        `    image: ${images["core"]}`,
        "    restart: unless-stopped",
        "    depends_on: [ ferretdb ]",
        `    ports: [ "${KOMODO_CORE_PORT}:9120" ]`,
        "    env_file: ./.env",
        // config.toml carries the git-provider account, bound read-only; relative to --project-directory (STATE_DIR).
        "    volumes: [ keys:/config/keys, ./config.toml:/config/config.toml:ro ]",
        stampLabels("komodo", stamp),
        // Inbound mode: no core_address, so periphery's listener stays up; PERIPHERY_CORE_ADDRESS would disable it.
        "  periphery:",
        `    image: ${images["periphery"]}`,
        "    restart: unless-stopped",
        // Bind-mounts /proc; masked paths over it hard-fail on WSL2 kernels ("can't mask path /proc/interrupts").
        "    security_opt: [ systempaths=unconfined ]",
        "    volumes: [ /var/run/docker.sock:/var/run/docker.sock, /proc:/proc, keys:/config/keys ]",
        "volumes: { postgres-data: {}, ferretdb-state: {}, keys: {} }",
        "",
    ].join("\n");

// Provider accounts Komodo uses: git_provider (Forgejo stack only) and docker_registry; neither can be set via
// env in Komodo v2, only this file. docker_registry's domain is what image_registry_account selects.
const configToml = (parsed: KomodoInputs): string => {
    const lines: string[] = [];
    if (parsed.gitUrl !== undefined && parsed.gitAccount !== undefined && parsed.gitToken !== undefined) {
        const git = gitProvider(parsed.gitUrl);
        lines.push(
            "[[git_provider]]",
            `domain = "${git.domain}"`,
            `https = ${git.https}`,
            `accounts = [{ username = "${parsed.gitAccount}", token = "${parsed.gitToken}" }]`,
            "",
        );
    }
    lines.push(
        "[[docker_registry]]",
        `domain = "${parsed.registry}"`,
        `accounts = [{ username = "${parsed.registryUser}", token = "${parsed.registryToken}" }]`,
        "",
    );
    return lines.join("\n");
};

// The write-once .env: known values plus the three secrets the host generates (`openssl rand -hex 32`) and never
// sends back. Written by writeEnvOnce, so it is 0600 and a failed write fails the apply.
const envEntries = (parsed: KomodoInputs): readonly EnvEntry[] => [
    { key: "TZ", value: "Etc/UTC" },
    { key: "KOMODO_LOCAL_AUTH", value: "true" },
    { key: "KOMODO_CONFIG_PATH", value: "/config/config.toml" },
    { key: "KOMODO_INIT_ADMIN_USERNAME", value: parsed.adminUser },
    { key: "KOMODO_DATABASE_ADDRESS", value: "ferretdb:27017" },
    { key: "KOMODO_FIRST_SERVER_NAME", value: "Local" },
    { key: "KOMODO_FIRST_SERVER_ADDRESS", value: "https://periphery:8120" },
    // How often Komodo polls for a new digest; a CI push goes live within this window even without notify.
    { key: "KOMODO_RESOURCE_POLL_INTERVAL", value: "1-min" },
    { key: "KOMODO_HOST", value: `https://${parsed.domain}` },
    { key: "KOMODO_INIT_ADMIN_PASSWORD", value: parsed.adminPassword },
    { key: "KOMODO_DATABASE_USERNAME", value: "komodo" },
    { key: "KOMODO_PASSKEY" },
    { key: "KOMODO_JWT_SECRET" },
    { key: "KOMODO_DATABASE_PASSWORD" },
];

// Komodo (deploy orchestrator) as a co-located FerretDB + Core + Periphery compose stack on the shared compose-service
// skeleton: `read` gates on Core's health (no health route; it answers 200 on / once connected to the database),
// `apply` is idempotent via `docker compose up -d`, and a pin bump under updatePolicy:"guarded" runs as a snapshot +
// health-gate + rollback transaction over its three volumes. No passkey/apiKey output; notify uses admin login.
export const createKomodoProvider = (executor: SshExecutor): Provider =>
    createComposeServiceProvider(
        {
            kind: "komodo",
            schema: komodoSchema,
            port: KOMODO_CORE_PORT,
            healthPath: "",
            readyTimeoutMs: 90_000,
            pendingRefs: ["internalIp", "gitUrl", "gitAccount", "gitToken", "registry", "registryUser", "registryToken"],
            // The owner stamp is not read back: an update here is a guarded snapshot-and-recreate of the whole control
            // plane, too heavy to run just to add a label. Komodo picks up its owner on its next real recreate.
            adoptsOwner: false,
            // config.toml carries the git and registry tokens, so it is 0600 like the .env.
            files: (parsed, stamp, images) => ({ "compose.yaml": composeYaml(images, stamp), "config.toml": { content: configToml(parsed), secret: true } }),
            env: envEntries,
            images: desiredImages,
            guard: (parsed) =>
                parsed.guardRepo === undefined || parsed.resticImage === undefined
                    ? undefined
                    : {
                          repo: parsed.guardRepo,
                          resticImage: parsed.resticImage,
                          volumes: ["komodo_postgres-data", "komodo_keys", "komodo_ferretdb-state"],
                          tag: `intentic-preupdate-${CORE}`,
                      },
        },
        executor,
    );
