import { join } from "node:path";

// The compatibility tier's shape, shared by its global setup (which boots it) and its spec (which reads where it came
// up). It is the sign-in tier (../signin) with one more piece: a sandbox daemon from the RELEASED image, the one
// owners' sandboxes run, which is older than the editor this commit builds.

// What owners run: the image every sandbox's update check follows. COMPAT_E2E_IMAGE points it elsewhere (a version
// tag, to check today's editor against an older release, or a local build).
export const COMPAT_IMAGE = process.env[`COMPAT_E2E_IMAGE`] || `ghcr.io/intentic/sandbox:stable`;

export const RESULTS_DIR = join(import.meta.dirname, `..`, `.cache`, `compat-results`);

// Set by the global setup; read by the spec through `daemonUnderTest`.
const ENV_DAEMON_URL = `COMPAT_E2E_DAEMON_URL`;
const ENV_CONNECT_TOKEN = `COMPAT_E2E_CONNECT_TOKEN`;
const ENV_DAEMON_VERSION = `COMPAT_E2E_DAEMON_VERSION`;

export interface DaemonUnderTest {
    // Where the browser reaches it: testcontainers' host and mapped port, which a CI job container reaches as well.
    readonly url: string;
    // The token it was started with, which the seeded sandbox row carries, so its /health names the id the editor expects.
    readonly connectToken: string;
    // What its /health says it is, or its image for a daemon from before /health named its build.
    readonly version: string;
}

export const announceDaemon = (daemon: DaemonUnderTest): void => {
    process.env[ENV_DAEMON_URL] = daemon.url;
    process.env[ENV_CONNECT_TOKEN] = daemon.connectToken;
    process.env[ENV_DAEMON_VERSION] = daemon.version;
};

export const daemonUnderTest = (): DaemonUnderTest => {
    const url = process.env[ENV_DAEMON_URL];
    const connectToken = process.env[ENV_CONNECT_TOKEN];
    const version = process.env[ENV_DAEMON_VERSION];
    if (url === undefined || connectToken === undefined || version === undefined) {
        throw new Error(`the compatibility stack is not up: run this through compat.playwright.config.ts, whose global setup boots it`);
    }
    return { url, connectToken, version };
};
