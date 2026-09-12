// The builder's entrypoint script (written by hosted-build.ts); busybox sh only, no bash/curl/jq. Four steps:
// 1. buildkitd up on a unix socket, no entitlements.
// 2. `buildctl build` under `timeout`, Dockerfile as the whole build context.
// 3. push to the sandbox app's own registry under one moving tag; digest lands in the metadata file.
// 4. report exit code, digest, and log tail to the platform, then exit with the build's code.

export const BUILD_PATHS = {
    // Holds only the Dockerfile; `COPY . /x` copies just it.
    context: `/build/context`,
    dockerfile: `/build/context/Dockerfile`,
    script: `/build/run.sh`,
    dockerConfig: `/root/.docker/config.json`,
    log: `/build/log`,
    metadata: `/build/meta.json`,
} as const;

// Env names the script reads; written only by hosted-build.ts.
export const BUILD_ENV = {
    image: `INTENTIC_BUILD_IMAGE`,
    cache: `INTENTIC_BUILD_CACHE`,
    timeoutSeconds: `INTENTIC_BUILD_TIMEOUT_SECONDS`,
    reportUrl: `INTENTIC_BUILD_REPORT_URL`,
    secret: `INTENTIC_BUILD_SECRET`,
} as const;

// Log bytes kept in the report: enough for a failed apt/compile, small enough for a row.
export const LOG_TAIL_BYTES = 64 * 1024;

// Headers the report carries beside its text body; the report route reads exactly these.
export const REPORT_HEADERS = {
    secret: `x-intentic-build`,
    exitCode: `x-intentic-exit`,
    digest: `x-intentic-digest`,
} as const;

const SOCKET = `unix:///run/buildkit/buildkitd.sock`;

export const buildScript = (): string =>
    [
        `#!/bin/sh`,
        `# intentic overlay build: written by the platform (hosted-build-script.ts), run as this machine's entrypoint.`,
        `set -u`,
        `mkdir -p /build /run/buildkit`,
        `: > ${BUILD_PATHS.log}`,
        `report() {`,
        `    DIGEST=""`,
        `    if [ -f ${BUILD_PATHS.metadata} ]; then`,
        `        DIGEST=$(sed -n 's/.*"containerimage.digest": *"\\([^"]*\\)".*/\\1/p' ${BUILD_PATHS.metadata} | head -n 1)`,
        `    fi`,
        `    tail -c ${LOG_TAIL_BYTES} ${BUILD_PATHS.log} > /build/log.tail 2>/dev/null || : > /build/log.tail`,
        `    wget -q -O - --timeout=30 \\`,
        `        --header "content-type: text/plain" \\`,
        `        --header "${REPORT_HEADERS.secret}: $${BUILD_ENV.secret}" \\`,
        `        --header "${REPORT_HEADERS.exitCode}: $1" \\`,
        `        --header "${REPORT_HEADERS.digest}: $DIGEST" \\`,
        `        --post-file=/build/log.tail "$${BUILD_ENV.reportUrl}" >/dev/null 2>&1 || true`,
        `}`,
        `buildkitd --addr ${SOCKET} >/build/buildkitd.log 2>&1 &`,
        `UP=0`,
        `for i in $(seq 1 60); do`,
        `    if buildctl --addr ${SOCKET} debug workers >/dev/null 2>&1; then UP=1; break; fi`,
        `    sleep 1`,
        `done`,
        `if [ "$UP" != "1" ]; then`,
        `    echo "buildkitd did not start" >> ${BUILD_PATHS.log}`,
        `    cat /build/buildkitd.log >> ${BUILD_PATHS.log} 2>/dev/null`,
        `    report 125`,
        `    exit 125`,
        `fi`,
        `(`,
        `    timeout "$${BUILD_ENV.timeoutSeconds}" buildctl --addr ${SOCKET} build \\`,
        `        --frontend dockerfile.v0 \\`,
        `        --local context=${BUILD_PATHS.context} \\`,
        `        --local dockerfile=${BUILD_PATHS.context} \\`,
        `        --output "type=image,name=$${BUILD_ENV.image},push=true" \\`,
        `        --export-cache "type=registry,ref=$${BUILD_ENV.cache},mode=min" \\`,
        `        --import-cache "type=registry,ref=$${BUILD_ENV.cache}" \\`,
        `        --metadata-file ${BUILD_PATHS.metadata}`,
        `    echo $? > /build/rc`,
        `) 2>&1 | tee -a ${BUILD_PATHS.log}`,
        `RC=$(cat /build/rc 2>/dev/null || echo 1)`,
        `report "$RC"`,
        `exit "$RC"`,
        ``,
    ].join(`\n`);

// Registry login buildctl reads, in docker's config shape. Username is Fly's fixed `x`; password is the app-scoped
// deploy token for this build (fly-tokens.ts).
export const dockerConfigJson = (registry: string, token: string): string =>
    `${JSON.stringify({ auths: { [registry]: { auth: Buffer.from(`x:${token}`, `utf8`).toString(`base64`) } } })}\n`;
