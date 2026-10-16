import { randomBytes } from "node:crypto";
import { GenericContainer, PullPolicy, type StartedTestContainer, Wait } from "testcontainers";
import bootSignInStack from "../signin/boot.js";
import { announceDaemon, COMPAT_IMAGE, type DaemonUnderTest } from "./compat-tier.js";

// Boots the compatibility tier: the sign-in tier whole (this commit's web build served as the web image serves it, the
// api harness, Postgres with the migrations replayed, Google stood in for), then a sandbox daemon from the released
// image beside it. The daemon runs the way the browser tier's does (../global-setup.ts): loopback auth off
// (SANDBOX_ALLOW_UNAUTHENTICATED) and no platform to announce to, since what is under test is the browser meeting an
// older daemon, not its sign-in. It is reached through testcontainers' host/port mapping, like the Postgres, so the tier
// runs inside a CI job container.

// Generous: the released image is a few GB, and a CI runner pulls it whenever `stable` moved since it last did.
const STARTUP_MS = 240_000;
// Listening comes before converging; the editor would hold every read until this anyway (its warming gate).
const READY_MS = 120_000;

interface HealthReading {
    readonly boot?: { readonly ready?: boolean };
    readonly build?: { readonly version?: string };
}

const readyHealth = async (url: string): Promise<HealthReading> => {
    const deadline = Date.now() + READY_MS;
    let last: HealthReading = {};
    while (Date.now() < deadline) {
        // SAFETY: only the two fields above are read, each optional and checked before use; a daemon of any age answers
        // /health with an object, and a body without them reads as not ready yet.
        last = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) })
            .then(async (response) => (response.ok ? ((await response.json()) as HealthReading) : last))
            .catch(() => last);
        if (last.boot?.ready === true) {
            return last;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`the sandbox daemon (${COMPAT_IMAGE}) at ${url} never finished booting in ${READY_MS / 1000}s`);
};

export default async function globalSetup(): Promise<() => Promise<void>> {
    const stopStack = await bootSignInStack();
    let container: StartedTestContainer | undefined;
    const teardown = async (): Promise<void> => {
        await container?.stop();
        await stopStack();
    };
    try {
        const connectToken = randomBytes(16).toString(`base64url`);
        container = await new GenericContainer(COMPAT_IMAGE)
            // A moving tag is resolved again every run, never whatever a runner pulled last time.
            .withPullPolicy(PullPolicy.alwaysPull())
            .withEnvironment({ CONNECT_TOKEN: connectToken, ZONE: `e2e.invalid`, SANDBOX_ALLOW_UNAUTHENTICATED: `1` })
            .withExposedPorts(8787)
            .withWaitStrategy(Wait.forHttp(`/health`, 8787).forStatusCode(200))
            .withStartupTimeout(STARTUP_MS)
            .start();
        const url = `http://${container.getHost()}:${container.getMappedPort(8787)}`;
        const health = await readyHealth(url);
        // A daemon from before /health named its build is called by its image instead.
        const daemon: DaemonUnderTest = { url, connectToken, version: health.build?.version ?? COMPAT_IMAGE };
        announceDaemon(daemon);
        process.stdout.write(`compatibility tier: ${COMPAT_IMAGE} answers as ${daemon.version} at ${url}\n`);
    } catch (error) {
        await teardown();
        throw error;
    }
    return teardown;
}
