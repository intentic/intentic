/* WHAT A BUILDER MACHINE RUNS, as one shell script the platform writes into it (hosted-build.ts puts it at
 * BUILD_PATHS.script through the machine config's `files` and makes it the entrypoint). The buildkit image
 * is Alpine with busybox, so everything here is busybox sh: no bash, no curl, no jq.
 *
 * Four steps, and the shape of each is a brake as much as a step:
 *   1. buildkitd up, on a unix socket, with no entitlements (no host network, no insecure security mode).
 *   2. `buildctl build` under `timeout`, so the machine stops itself at the platform's limit even when the
 *      platform is unreachable and cannot destroy it. The Dockerfile is the whole build context.
 *   3. The result is pushed to the sandbox app's own registry path under one moving tag, with the layer
 *      cache beside it; the image's digest lands in the metadata file.
 *   4. One report to the platform, authenticated by the build's secret: the exit code and digest in headers,
 *      the log's tail as the body, so nothing needs JSON-escaping in shell. Then exit with the build's code.
 *
 * The registry login is a file the platform wrote (BUILD_PATHS.dockerConfig): buildctl reads it as docker
 * would. Everything the script needs to know beyond that arrives as env, listed in `BUILD_ENV`. */

export const BUILD_PATHS = {
    // The build context holds the Dockerfile and nothing else: `COPY . /x` copies a Dockerfile.
    context: `/build/context`,
    dockerfile: `/build/context/Dockerfile`,
    script: `/build/run.sh`,
    dockerConfig: `/root/.docker/config.json`,
    log: `/build/log`,
    metadata: `/build/meta.json`,
} as const;

// The env names the script reads, written by hosted-build.ts and nothing else.
export const BUILD_ENV = {
    image: `INTENTIC_BUILD_IMAGE`,
    cache: `INTENTIC_BUILD_CACHE`,
    timeoutSeconds: `INTENTIC_BUILD_TIMEOUT_SECONDS`,
    reportUrl: `INTENTIC_BUILD_REPORT_URL`,
    secret: `INTENTIC_BUILD_SECRET`,
} as const;

// How much of the log rides in the report. Enough to read a failed apt or compile; small enough to be a row.
export const LOG_TAIL_BYTES = 64 * 1024;

// The headers the report carries beside its text body; the report route reads exactly these.
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

// The registry login buildctl reads, docker's own file shape. Username is Fly's fixed `x`; the password is
// the app-scoped deploy token minted for this build (fly-tokens.ts).
export const dockerConfigJson = (registry: string, token: string): string =>
    `${JSON.stringify({ auths: { [registry]: { auth: Buffer.from(`x:${token}`, `utf8`).toString(`base64`) } } })}\n`;
