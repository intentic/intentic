import { setTimeout as sleep } from "node:timers/promises";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { HASH_KEY } from "@intentic/graph";
import { z } from "zod";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { containerLabel } from "../core/backing-ssh.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshSession } from "../core/ssh.js";
import { type SshExecutor, sshExecutor } from "../core/ssh.js";
import { SERVICE_LOGGING } from "../services/compose-service.js";

const signozSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    // The dashboard admin SignOz authenticates by email; intentic generates the password and reports it.
    adminUser: z.string(),
    adminPassword: z.string(),
    // The fully-pinned images for the stack, inlined into the compose YAML so a bump recreates the changed
    // service on the next apply; read observes each running image and diff drives it. The telemetrystore
    // migrator runs from the otel-collector image, so it has no pin of its own.
    clickhouseImage: z.string(),
    signozImage: z.string(),
    otelImage: z.string(),
    zookeeperImage: z.string(),
});
type SignozInputs = z.infer<typeof signozSchema>;
const parse = (inputs: ResolvedInputs): SignozInputs => parseInputs(signozSchema, inputs, "signoz");

const UI_PORT = 8080;
// OTLP ingest published on the host: gRPC 4317 + HTTP 4318. Apps reach the HTTP port through the service's
// `otlpEndpoint` output (http://<internalIp>:4318); it is host-internal, never tunnel-routed.
const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;
const STATE_DIR = "/opt/intentic/signoz";
const READY_TIMEOUT_MS = 300_000;
const READY_INTERVAL_MS = 4_000;
// The histogram-quantile UDF release the init step fetches into ClickHouse's user_scripts (SigNoz needs it
// for percentile queries); pinned to the version SigNoz's v0.129 reference uses.
const HISTOGRAM_QUANTILE_VERSION = "v0.0.1";

const internalUrl = (parsed: SignozInputs): string => `http://${parsed.internalIp}:${UI_PORT}`;
const otlpEndpoint = (parsed: SignozInputs): string => `http://${parsed.internalIp}:${OTLP_HTTP_PORT}`;
const outputsFor = (parsed: SignozInputs): Record<string, unknown> => ({
    url: `https://${parsed.domain}`,
    internalUrl: internalUrl(parsed),
    otlpEndpoint: otlpEndpoint(parsed),
});

const running = async (session: SshSession, id: string): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "label=intentic.id=${id}" --format '{{.Names}}'`);
    return result.stdout.trim() !== "";
};

// The create-time image of each long-running compose service, keyed by compose service name. The one-shot
// init-clickhouse + telemetrystore-migrator exit, so they never show here; the migrator's image tracks the
// otel collector's (same image), so diffing the collector covers it. Returns {} when the stack is down.
const PROJECT = "signoz";
const runningImages = async (session: SshSession): Promise<Record<string, string>> => {
    const result = await session.exec(
        `ids=$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}"); ` +
            `[ -n "$ids" ] && docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}={{.Config.Image}}' $ids || true`,
    );
    const images: Record<string, string> = {};
    for (const line of result.stdout.trim().split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
            images[line.slice(0, eq)] = line.slice(eq + 1);
        }
    }
    return images;
};

const desiredImages = (parsed: SignozInputs): Record<string, string> => ({
    zookeeper: parsed.zookeeperImage,
    clickhouse: parsed.clickhouseImage,
    signoz: parsed.signozImage,
    "otel-collector": parsed.otelImage,
});

// The SigNoz v0.129 reference stack, faithfully reproduced: a separate ZooKeeper for ClickHouse coordination,
// an init step that fetches the histogram-quantile UDF, ClickHouse (stock image + a config.d cluster drop-in
// + the UDF function file), the telemetrystore migrator (bootstrap + sync + async, from the otel image), the
// SigNoz server, and the OTel collector. Image refs are the pinned inputs inlined into the YAML so a bump
// recreates the changed service on the next `up -d`. Per-service config + the JWT secret are mounted from
// the files ensureFiles writes beside it.
const composeYaml = (parsed: SignozInputs, id: string, hash: string): string =>
    [
        "services:",
        // Fetch the histogram-quantile UDF binary into the shared user_scripts volume before ClickHouse starts.
        "  init-clickhouse:",
        `    image: ${parsed.clickhouseImage}`,
        "    restart: on-failure",
        "    command: [ bash, /init-clickhouse.sh ]",
        "    volumes:",
        "      - user-scripts:/var/lib/clickhouse/user_scripts/",
        "      - ./init-clickhouse.sh:/init-clickhouse.sh:ro",
        "  zookeeper:",
        `    image: ${parsed.zookeeperImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    user: root",
        "    environment:",
        "      - ZOO_SERVER_ID=1",
        "      - ALLOW_ANONYMOUS_LOGIN=yes",
        "      - ZOO_AUTOPURGE_INTERVAL=1",
        "    volumes: [ zookeeper:/bitnami/zookeeper ]",
        "    healthcheck:",
        '      test: [ CMD-SHELL, "curl -s -m 2 http://localhost:8080/commands/ruok | grep -q error.*null" ]',
        "      interval: 30s",
        "      timeout: 5s",
        "      retries: 6",
        "  clickhouse:",
        `    image: ${parsed.clickhouseImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    tty: true",
        "    environment: [ CLICKHOUSE_SKIP_USER_SETUP=1 ]",
        "    depends_on:",
        "      init-clickhouse: { condition: service_completed_successfully }",
        "      zookeeper: { condition: service_healthy }",
        "    volumes:",
        "      - clickhouse:/var/lib/clickhouse/",
        "      - user-scripts:/var/lib/clickhouse/user_scripts/",
        "      - ./cluster.xml:/etc/clickhouse-server/config.d/cluster.xml:ro",
        "      - ./custom-function.xml:/etc/clickhouse-server/custom-function.xml:ro",
        "    healthcheck:",
        "      test: [ CMD, wget, --spider, -q, 0.0.0.0:8123/ping ]",
        "      interval: 30s",
        "      timeout: 5s",
        "      retries: 6",
        // Run the schema migrations once (bootstrap + sync + async) from the otel-collector image.
        "  signoz-migrator:",
        `    image: ${parsed.otelImage}`,
        "    restart: on-failure",
        "    depends_on: { clickhouse: { condition: service_healthy } }",
        "    environment:",
        "      - SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_DSN=tcp://clickhouse:9000",
        "      - SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_CLUSTER=cluster",
        "      - SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_REPLICATION=true",
        "    entrypoint: [ /bin/sh ]",
        '    command: [ -c, "/signoz-otel-collector migrate bootstrap && /signoz-otel-collector migrate sync up && /signoz-otel-collector migrate async up" ]',
        "  signoz:",
        `    image: ${parsed.signozImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    depends_on: { clickhouse: { condition: service_healthy } }",
        `    ports: [ "${UI_PORT}:8080" ]`,
        "    environment:",
        "      - SIGNOZ_ALERTMANAGER_PROVIDER=signoz",
        "      - SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN=tcp://clickhouse:9000",
        "      - SIGNOZ_SQLSTORE_SQLITE_PATH=/var/lib/signoz/signoz.db",
        "    env_file: ./.env",
        "    volumes: [ sqlite:/var/lib/signoz/ ]",
        `    labels: [ "intentic.id=${id}", "intentic.type=signoz", "intentic.hash=${hash}" ]`,
        "  otel-collector:",
        `    image: ${parsed.otelImage}`,
        "    restart: unless-stopped",
        SERVICE_LOGGING,
        "    depends_on: { clickhouse: { condition: service_healthy }, signoz: { condition: service_started } }",
        "    entrypoint: [ /bin/sh ]",
        '    command: [ -c, "/signoz-otel-collector migrate sync check && /signoz-otel-collector --config=/etc/otel-collector-config.yaml --manager-config=/etc/manager-config.yaml --copy-path=/var/tmp/collector-config.yaml" ]',
        "    environment:",
        "      - OTEL_RESOURCE_ATTRIBUTES=host.name=signoz-host,os.type=linux",
        "      - LOW_CARDINAL_EXCEPTION_GROUPING=false",
        "      - SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_DSN=tcp://clickhouse:9000",
        "      - SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_CLUSTER=cluster",
        "      - SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_REPLICATION=true",
        "    volumes:",
        "      - ./otel-collector-config.yaml:/etc/otel-collector-config.yaml:ro",
        "      - ./otel-collector-opamp-config.yaml:/etc/manager-config.yaml:ro",
        `    ports: [ "${OTLP_GRPC_PORT}:4317", "${OTLP_HTTP_PORT}:4318" ]`,
        "volumes: { clickhouse: {}, sqlite: {}, zookeeper: {}, user-scripts: {} }",
        "",
    ].join("\n");

// Downloads the histogram-quantile UDF binary for the host architecture into ClickHouse's user_scripts dir.
// A mounted file (not a compose command), so normal `$( )` works without compose `$$` escaping.
const initScript = (): string =>
    [
        "#!/bin/bash",
        "set -e",
        `version="${HISTOGRAM_QUANTILE_VERSION}"`,
        "node_os=$(uname -s | tr '[:upper:]' '[:lower:]')",
        "node_arch=$(uname -m | sed s/aarch64/arm64/ | sed s/x86_64/amd64/)",
        // literal bash variable expansion in the init script
        'url="https://github.com/SigNoz/signoz/releases/download/histogram-quantile%2F${version}/histogram-quantile_${node_os}_${node_arch}.tar.gz"',
        "cd /tmp",
        'wget -O histogram-quantile.tar.gz "$url"',
        "tar -xzf histogram-quantile.tar.gz",
        "mv histogram-quantile /var/lib/clickhouse/user_scripts/histogramQuantile",
        "",
    ].join("\n");

// A config.d drop-in over the stock ClickHouse image: the ZooKeeper coordinates, the single-shard "cluster"
// SigNoz's migrator targets (with macros for the Replicated tables), and the UDF wiring (user_scripts path +
// the custom-function file), so the histogramQuantile function loads regardless of the image's default glob.
const clusterXml = (): string =>
    [
        "<clickhouse>",
        "  <zookeeper><node><host>zookeeper</host><port>2181</port></node></zookeeper>",
        "  <remote_servers><cluster><shard><internal_replication>true</internal_replication>",
        "    <replica><host>clickhouse</host><port>9000</port></replica>",
        "  </shard></cluster></remote_servers>",
        "  <macros><shard>01</shard><replica>replica-1</replica></macros>",
        "  <user_scripts_path>/var/lib/clickhouse/user_scripts/</user_scripts_path>",
        "  <user_defined_executable_functions_config>/etc/clickhouse-server/custom-function.xml</user_defined_executable_functions_config>",
        "</clickhouse>",
        "",
    ].join("\n");

// The histogramQuantile executable UDF definition (verbatim from SigNoz's reference custom-function.xml).
const customFunctionXml = (): string =>
    [
        "<functions>",
        "    <function>",
        "        <type>executable</type>",
        "        <name>histogramQuantile</name>",
        "        <return_type>Float64</return_type>",
        "        <argument><type>Array(Float64)</type><name>buckets</name></argument>",
        "        <argument><type>Array(Float64)</type><name>counts</name></argument>",
        "        <argument><type>Float64</type><name>quantile</name></argument>",
        "        <format>CSV</format>",
        "        <command>./histogramQuantile</command>",
        "    </function>",
        "</functions>",
        "",
    ].join("\n");

// The OpAMP manager endpoint the collector connects to (SigNoz serves it on 4320).
const opampConfig = (): string => "server_endpoint: ws://signoz:4320/v1/opamp\n";

// The OTel collector pipeline config, verbatim from SigNoz's v0.129 reference (deploy/docker/
// otel-collector-config.yaml) — the exporters/connectors the v0.144 collector + the SigNoz server expect.
const otelCollectorConfig = (): string =>
    [
        "connectors:",
        "  signozmeter:",
        "    metrics_flush_interval: 1h",
        "    dimensions:",
        "      - name: service.name",
        "      - name: deployment.environment",
        "      - name: host.name",
        "receivers:",
        "  otlp:",
        "    protocols:",
        "      grpc:",
        "        endpoint: 0.0.0.0:4317",
        "      http:",
        "        endpoint: 0.0.0.0:4318",
        "  prometheus:",
        "    config:",
        "      global:",
        "        scrape_interval: 60s",
        "      scrape_configs:",
        "        - job_name: otel-collector",
        "          static_configs:",
        "          - targets:",
        "              - localhost:8888",
        "            labels:",
        "              job_name: otel-collector",
        "processors:",
        "  batch:",
        "    send_batch_size: 10000",
        "    send_batch_max_size: 11000",
        "    timeout: 10s",
        "  batch/meter:",
        "    send_batch_max_size: 25000",
        "    send_batch_size: 20000",
        "    timeout: 1s",
        "  resourcedetection:",
        "    detectors: [env, system]",
        "    timeout: 2s",
        "  signozspanmetrics/delta:",
        "    metrics_exporter: signozclickhousemetrics",
        "    metrics_flush_interval: 60s",
        "    latency_histogram_buckets: [100us, 1ms, 2ms, 6ms, 10ms, 50ms, 100ms, 250ms, 500ms, 1000ms, 1400ms, 2000ms, 5s, 10s, 20s, 40s, 60s ]",
        "    dimensions_cache_size: 100000",
        "    aggregation_temporality: AGGREGATION_TEMPORALITY_DELTA",
        "    enable_exp_histogram: true",
        "    dimensions:",
        "      - name: service.namespace",
        "        default: default",
        "      - name: deployment.environment",
        "        default: default",
        "      - name: signoz.collector.id",
        "      - name: service.version",
        "      - name: browser.platform",
        "      - name: browser.mobile",
        "      - name: k8s.cluster.name",
        "      - name: k8s.node.name",
        "      - name: k8s.namespace.name",
        "      - name: host.name",
        "      - name: host.type",
        "      - name: container.name",
        "extensions:",
        "  health_check:",
        "    endpoint: 0.0.0.0:13133",
        "  pprof:",
        "    endpoint: 0.0.0.0:1777",
        "exporters:",
        "  clickhousetraces:",
        "    datasource: tcp://clickhouse:9000/signoz_traces",
        // literal OTel collector env-var reference
        "    low_cardinal_exception_grouping: ${env:LOW_CARDINAL_EXCEPTION_GROUPING}",
        "    use_new_schema: true",
        "  signozclickhousemetrics:",
        "    dsn: tcp://clickhouse:9000/signoz_metrics",
        "  clickhouselogsexporter:",
        "    dsn: tcp://clickhouse:9000/signoz_logs",
        "    timeout: 10s",
        "    use_new_schema: true",
        "  signozclickhousemeter:",
        "    dsn: tcp://clickhouse:9000/signoz_meter",
        "    timeout: 45s",
        "    sending_queue:",
        "      enabled: false",
        "  metadataexporter:",
        "    cache:",
        "      provider: in_memory",
        "    dsn: tcp://clickhouse:9000/signoz_metadata",
        "    enabled: true",
        "    timeout: 45s",
        "service:",
        "  telemetry:",
        "    logs:",
        "      encoding: json",
        "  extensions:",
        "    - health_check",
        "    - pprof",
        "  pipelines:",
        "    traces:",
        "      receivers: [otlp]",
        "      processors: [signozspanmetrics/delta, batch]",
        "      exporters: [clickhousetraces, metadataexporter, signozmeter]",
        "    metrics:",
        "      receivers: [otlp]",
        "      processors: [batch]",
        "      exporters: [signozclickhousemetrics, metadataexporter, signozmeter]",
        "    metrics/prometheus:",
        "      receivers: [prometheus]",
        "      processors: [batch]",
        "      exporters: [signozclickhousemetrics, metadataexporter, signozmeter]",
        "    logs:",
        "      receivers: [otlp]",
        "      processors: [batch]",
        "      exporters: [clickhouselogsexporter, metadataexporter, signozmeter]",
        "    metrics/meter:",
        "      receivers: [signozmeter]",
        "      processors: [batch/meter]",
        "      exporters: [signozclickhousemeter]",
        "",
    ].join("\n");

// Write the compose + the config files (always) and a once-written .env carrying the JWT signing secret (it
// must survive restarts — re-keying would invalidate every session). The secret is generated host-side.
const ensureFiles = async (session: SshSession, parsed: SignozInputs, id: string, hash: string): Promise<void> => {
    await session.exec(`mkdir -p ${STATE_DIR}`);
    await session.exec(`cat > ${STATE_DIR}/compose.yaml <<'COMPOSE_EOF'\n${composeYaml(parsed, id, hash)}COMPOSE_EOF`);
    await session.exec(`cat > ${STATE_DIR}/init-clickhouse.sh <<'INIT_EOF'\n${initScript()}INIT_EOF`);
    await session.exec(`cat > ${STATE_DIR}/cluster.xml <<'CLUSTER_EOF'\n${clusterXml()}CLUSTER_EOF`);
    await session.exec(`cat > ${STATE_DIR}/custom-function.xml <<'FN_EOF'\n${customFunctionXml()}FN_EOF`);
    await session.exec(`cat > ${STATE_DIR}/otel-collector-config.yaml <<'OTEL_EOF'\n${otelCollectorConfig()}OTEL_EOF`);
    await session.exec(`cat > ${STATE_DIR}/otel-collector-opamp-config.yaml <<'OPAMP_EOF'\n${opampConfig()}OPAMP_EOF`);
    await session.exec(
        `test -f ${STATE_DIR}/.env || { printf 'SIGNOZ_TOKENIZER_JWT_SECRET=%s\\n' "$(openssl rand -hex 32)" > ${STATE_DIR}/.env && chmod 600 ${STATE_DIR}/.env; }`,
    );
};

// Probe the UI FROM THE HOST over SSH (SigNoz publishes 8080 on the host), so the check works regardless of
// whether the engine's own network can reach the host's internal ip. It answers 200 on /api/v1/health once up.
const healthy = async (session: SshSession, parsed: SignozInputs): Promise<boolean> => {
    const result = await session.exec(`wget -q -T 10 -O /dev/null ${internalUrl(parsed)}/api/v1/health`);
    return result.code === 0;
};

const waitHealthy = async (session: SshSession, parsed: SignozInputs): Promise<void> => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
        if (await healthy(session, parsed)) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`signoz did not become healthy within ${READY_TIMEOUT_MS}ms`);
        }
        await sleep(READY_INTERVAL_MS);
    }
};

// Seed the dashboard's first admin via SigNoz's register API, FROM THE HOST over SSH. Best-effort and
// idempotent: once a user exists SigNoz rejects re-registration, which we log and ignore rather than fail.
const seedAdmin = async (session: SshSession, parsed: SignozInputs, log: (message: string) => void): Promise<void> => {
    const body = JSON.stringify({ name: "intentic", orgName: "intentic", email: parsed.adminUser, password: parsed.adminPassword });
    const result = await session.exec(
        `curl -s -o /dev/null -w '%{http_code}' -X POST ${internalUrl(parsed)}/api/v1/register -H 'Content-Type: application/json' -d '${body}'`,
    );
    if (result.stdout.trim() !== "200") {
        log(`signoz: register returned ${result.stdout.trim() || "no status"} (admin likely already seeded)`);
    }
};

// SigNoz (observability) as a co-located ZooKeeper + ClickHouse + migrator + query/UI + OTLP-collector compose
// stack on the host, mirroring SigNoz's v0.129 reference. read returns the resource only when the UI is up (so
// a noop re-derives the deterministic url/internalUrl/otlpEndpoint) and surfaces the running images; diff
// recreates a service on an image-pin bump. apply is idempotent: `docker compose up -d` reconciles the stack,
// the named volumes persist, and the admin seed tolerates an existing account.
export const createSignozProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A dependency of these $ref inputs is still a pending create (plan resolves leniently) —
        // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
        if (hasPendingRef(inputs, "internalIp")) {
            return undefined;
        }
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`signoz "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            if (!(await running(session, ctx.id)) || !(await healthy(session, parsed))) {
                return undefined;
            }
            const stampHash = await containerLabel(session, ctx.id, HASH_KEY);
            return { outputs: outputsFor(parsed), detail: { images: await runningImages(session) }, ...(stampHash === "" ? {} : { stampHash }) };
        } finally {
            await session.dispose();
        }
    },
    // `up -d` recreates only the services whose pinned image in compose.yaml changed; the named volumes
    // (clickhouse/sqlite/zookeeper) survive, so a bump is a safe in-place update gated on health.
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const images = (observed.detail?.["images"] ?? {}) as Record<string, string>;
        for (const [service, desired] of Object.entries(desiredImages(parsed))) {
            if (images[service] !== desired) {
                return { action: "update", reason: `signoz ${service} image differs (running ${String(images[service])}, want ${desired})` };
            }
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await ensureFiles(session, parsed, ctx.id, ctx.inputsHash ?? "");
            const up = await session.exec(`docker compose -p signoz --project-directory ${STATE_DIR} -f ${STATE_DIR}/compose.yaml up -d`);
            if (up.code !== 0) {
                throw new Error(`failed to bring up signoz stack: exited ${up.code}: ${up.stderr.trim()}`);
            }
            await waitHealthy(session, parsed);
            await seedAdmin(session, parsed, ctx.log);
            return outputsFor(parsed);
        } finally {
            await session.dispose();
        }
    },
    // Parses only the SSH block, so it works from a removed node's inputs AND a ListedResource's (a host's).
    delete: async (inputs) => {
        const session = await executor.connect(sshTarget(parseInputs(sshSchema, inputs, "signoz")));
        try {
            await session.exec(`docker compose -p signoz --project-directory ${STATE_DIR} -f ${STATE_DIR}/compose.yaml down -v 2>/dev/null || true`);
            await session.exec(`rm -rf ${STATE_DIR}`);
        } finally {
            await session.dispose();
        }
    },
    list: (sources, ctx) => listStampedContainers(executor, "signoz", sources, ctx.log),
});
