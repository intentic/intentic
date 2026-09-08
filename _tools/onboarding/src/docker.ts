import { execFile } from "node:child_process";
import { connect, createServer } from "node:net";
import { hostname } from "node:os";
import { promisify } from "node:util";

// The SPA's CSP allows http only to 127.0.0.1; anything else over http is silently blocked by the browser, not CORS.
// Loopback is the one address a process can be sure is its own; host.docker.internal answers a different question. Api
// and SPA share one host on two ports to stay same-site, or the session cookie drops.

const run = promisify(execFile);

// The only host this tier can serve its world on; the app's CSP requires it, not a preference.
export const HOST = `127.0.0.1`;

export const dockerAvailable = async (): Promise<boolean> => {
    try {
        await run(`docker`, [`version`, `--format`, `{{.Server.Version}}`], { timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
};

// Pre-allocates a port, rather than letting Docker pick, so the api and SPA can know each other's origin before either
// starts. Bound on 0.0.0.0, where Docker publishes, not loopback.
export const freePort = async (): Promise<number> =>
    new Promise<number>((resolvePort, rejectPort) => {
        const probe = createServer();
        probe.once(`error`, rejectPort);
        probe.listen(0, `0.0.0.0`, () => {
            const address = probe.address();
            if (address === null || typeof address === `string`) {
                probe.close(() => rejectPort(new Error(`could not reserve a host port`)));
                return;
            }
            const { port } = address;
            probe.close(() => resolvePort(port));
        });
    });

const reaches = async (port: number, timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolveProbe) => {
        const client = connect({ host: HOST, port, timeout: timeoutMs });
        const settle = (answer: boolean): void => {
            client.destroy();
            resolveProbe(answer);
        };
        client.once(`connect`, () => settle(true));
        client.once(`timeout`, () => settle(false));
        client.once(`error`, () => settle(false));
    });

// docker info's Name identifies the daemon actually running, not the caller's assumption, which is what tells 'loopback
// doesn't work here' apart from 'those containers are somebody else's' below.
const daemonIdentity = async (): Promise<string> => {
    const address = process.env[`DOCKER_HOST`] ?? `the default socket`;
    try {
        const { stdout } = await run(`docker`, [`info`, `--format`, `{{.Name}}`], { timeout: 10_000 });
        return `${stdout.trim()} over ${address}`;
    } catch {
        return `a daemon that will not say, over ${address}`;
    }
};

// Checked once, against the first container, so an environment that can't reach its own Docker's loopback fails with
// one sentence, not four mysterious timeouts.
export const requireLoopback = async (port: number, what: string, timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await reaches(port, 2_000)) {
            return;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    throw new Error(
        `${what} published a port that this process cannot reach at ${HOST}:${port}. It was published by ` +
            `${await daemonIdentity()}, and this process is on ${hostname()}. The onboarding tier serves its whole ` +
            `world on loopback, so the daemon it drives has to be the one this process is on: run it on the machine ` +
            `whose Docker this is, or — in a container, which is what CI does — give the container a dockerd of its own, ` +
            `on a socket path of its own, rather than driving somebody else's.`,
    );
};

// `urlFor` is for the api/SPA pair the browser and sandbox reach, which must be TLS (certs.ts). `plainUrlFor` is for
// same-process-only stand-ins, where a certificate would be ceremony.
export const urlFor = (port: number): string => `https://${HOST}:${port}`;
export const plainUrlFor = (port: number): string => `http://${HOST}:${port}`;
