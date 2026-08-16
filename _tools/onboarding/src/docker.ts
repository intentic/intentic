import { execFile } from "node:child_process";
import { connect, createServer } from "node:net";
import { promisify } from "node:util";

/* WHERE THIS TIER'S WORLD HAS TO LIVE, and why there is no choice about it.
 *
 * The browser tier beside this one (`_tools/e2e`) cannot run in CI, and its README says why: every server it
 * starts is addressed on `localhost`. The obvious correction is to address containers some other way — by the
 * host's gateway, or by their own addresses on the run's network — and both were tried here before the app
 * itself ruled them out.
 *
 * THE SPA SHIPS A CONTENT SECURITY POLICY, and it decides this:
 *
 *     connect-src 'self' https: wss: http://127.0.0.1:* ws://127.0.0.1:*
 *
 * An api reached over http at anything but 127.0.0.1 is refused by the browser before the request leaves the
 * page — not by CORS, which is configured correctly and answers correctly, but by the document's own policy.
 * The symptom is the router sending every route to "Intentic isn't reachable", a screen that names the network,
 * so the reader looks anywhere but at the one line responsible.
 *
 * The world is served over TLS for other reasons (certs.ts), which `https:` above allows anywhere — but it is
 * still published on LOOPBACK ports, because that is the one address a process can be sure is its own. A
 * container elsewhere reaches the same platform through `host.docker.internal`, which is a different question
 * with a different answer, and neither is a guess.
 *
 * Keeping api and SPA on ONE host with two ports is a second requirement met by the same choice: they are
 * separate origins that must stay same-site, or the browser drops the session cookie on every call the app
 * makes and a signed-in journey looks exactly like a broken login.
 */

const run = promisify(execFile);

// The one host this tier can serve its world on. See the header — it is the app's policy, not a preference.
export const HOST = `127.0.0.1`;

export const dockerAvailable = async (): Promise<boolean> => {
    try {
        await run(`docker`, [`version`, `--format`, `{{.Server.Version}}`], { timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
};

/* Reserve a free port on the host by taking it and letting go.
 *
 * Pre-allocating rather than letting Docker pick breaks a genuine circularity: the api must be told the SPA's
 * origin at boot and the SPA must be told the api's, so neither can wait for the other to start and report a
 * mapped port. There is a race between releasing the port and Docker binding it, and it is the standard one —
 * smaller than the fixed-port collisions it replaces, which is the choice a tier that blocks releases has.
 *
 * Bound on 0.0.0.0, because that is where Docker publishes: a port free only on loopback is not free.
 */
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

/* Prove that a container's published port is reachable on loopback from here, before anything depends on it.
 *
 * This is the tier's one environmental requirement, and it is checked once, against the first container up, so
 * an environment that cannot meet it says so in a sentence instead of as four services that each "never
 * started". It fails wherever the test process is in a container whose Docker publishes onto some OTHER
 * machine's loopback — which is exactly why the CI job for this tier runs on the host rather than in one.
 */
export const requireLoopback = async (port: number, what: string, timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await reaches(port, 2_000)) {
            return;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    throw new Error(
        `${what} published a port that this process cannot reach at ${HOST}:${port}. The onboarding tier serves its whole ` +
            `world on loopback, so it has to be running where Docker publishes — on the host, not in a container driving ` +
            `some other machine's daemon.`,
    );
};

/* The two addresses in this run, built here so nothing can quietly spell one its own way.
 *
 * `urlFor` is for the pair the BROWSER and the SANDBOX talk to — the api and the SPA — which must be TLS for
 * the reasons certs.ts sets out. `plainUrlFor` is for the stand-ins beside them, which only this process ever
 * polls: giving them certificates would be ceremony around a health check. */
export const urlFor = (port: number): string => `https://${HOST}:${port}`;
export const plainUrlFor = (port: number): string => `http://${HOST}:${port}`;
