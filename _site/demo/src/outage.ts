import type { HostReport, SandboxHosted } from "@intentic/api-contract";
import { EDGE_VERDICT_HEADER, type SandboxVitals, VITALS_PATH } from "@intentic/sandbox-contract";
import { type DemoHandler, json } from "./transport";

// WHICH OUTAGE this page load acts out, from `?outage=`, sticky per tab like the mode: the way to look at the
// diagnosis and the recovery panel (`@intentic/web` features/sandbox/diagnosis/) without breaking a real sandbox.
// `?outage=none` ends it. Each one is what a real sandbox in that state answers, at the same seams:
//   busy        the front answers vitals (daemon up, CPU starved); everything else hangs until the caller gives up
//   restarting  the front says its daemon is restarting, and keeps saying it
//   down        the edge holds no tunnel; nothing on the machine has reported
//   fixing      the edge holds no tunnel; the machine agent is starting Docker Desktop
//   needs-you   the edge holds no tunnel; the machine found what only its owner can fix
//   hosted      a machine we run, which failed to start; the platform kept the image before its last update

const OUTAGES = [`busy`, `restarting`, `down`, `fixing`, `needs-you`, `hosted`] as const;
export type DemoOutage = (typeof OUTAGES)[number];

const STORAGE_KEY = `intentic.demo.outage`;

const resolve = (): DemoOutage | undefined => {
    const url = new URL(window.location.href);
    const asked = url.searchParams.get(`outage`);
    if (asked !== null) {
        url.searchParams.delete(`outage`);
        window.history.replaceState(window.history.state, ``, url);
        if (asked === `none`) {
            window.sessionStorage.removeItem(STORAGE_KEY);
        }
    }
    const outage = OUTAGES.find((candidate) => candidate === (asked ?? window.sessionStorage.getItem(STORAGE_KEY)));
    if (outage !== undefined) {
        window.sessionStorage.setItem(STORAGE_KEY, outage);
    }
    return outage;
};

/** The outage this page load acts out, resolved once before boot; undefined for a sandbox that answers. */
export const demoOutage = resolve();

const REPORTED_AT = new Date().toISOString();

const FIXING: HostReport = {
    source: `agent`,
    machine: `ada-laptop`,
    os: `windows`,
    stage: `fixing`,
    doing: `Starting Docker Desktop…`,
    checks: [
        { id: `docker-app`, label: `Docker Desktop`, state: `fixing`, problem: `Docker Desktop wasn't running after the restart.`, fix: `auto` },
        { id: `container`, label: `Sandbox container`, state: `skip` },
    ],
    at: REPORTED_AT,
};

const NEEDS_YOU: HostReport = {
    source: `agent`,
    machine: `ada-laptop`,
    os: `windows`,
    stage: `done`,
    outcome: `needs-you`,
    checks: [
        { id: `docker-app`, label: `Docker Desktop`, state: `ok` },
        {
            id: `docker`,
            label: `Docker's engine`,
            state: `fail`,
            problem: `Docker Desktop is running but its engine hasn't answered for 6 minutes.`,
            remedy: `Restarting Docker Desktop usually clears this. The fix command asks before it does.`,
            fix: `consent`,
        },
        {
            id: `disk`,
            label: `Free disk space`,
            state: `warn`,
            problem: `4.2 GB free on C:, where Docker keeps its data.`,
            remedy: `Free at least 5 GB; a full disk is a common reason Docker stops answering.`,
            fix: `you`,
        },
    ],
    at: REPORTED_AT,
};

/** What the machine reported, on the platform's row. */
export const outageReport = (): HostReport | null => (demoOutage === `fixing` ? FIXING : demoOutage === `needs-you` ? NEEDS_YOU : null);

/** The hosted machine the row names, for the one outage on a machine we run. */
export const outageHosted = (): SandboxHosted | null => (demoOutage === `hosted` ? { region: `arn`, warm: true, canRollBack: true } : null);

const BUSY_VITALS: SandboxVitals = { node: `up`, lagMs: 14_200, restarts: 0, uptimeS: 7_260, pressure: { cpu: 97.4, memory: 31, io: 6 } };
const RESTARTING_VITALS: SandboxVitals = { node: `restarting`, lagMs: null, restarts: 1, uptimeS: 7_260, pressure: null };

// A request a stalled daemon never answers, given up the way the caller gives up: by its own signal.
const hang = (request: Request): Promise<Response> =>
    new Promise((_, reject) => {
        request.signal.addEventListener(`abort`, () => reject(new DOMException(`The operation was aborted.`, `AbortError`)), { once: true });
    });

const noTunnel = (): Response =>
    new Response(`sandbox-demo is not connected right now.\n`, { status: 502, headers: { [EDGE_VERDICT_HEADER]: `no-tunnel`, "content-type": `text/plain` } });

/** The daemon's handler, as this outage leaves it. */
export const withOutage =
    (daemon: DemoHandler): DemoHandler =>
    async (request, url) => {
        switch (demoOutage) {
            case undefined:
                return daemon(request, url);
            case `busy`:
                return url.pathname === VITALS_PATH ? json(BUSY_VITALS) : hang(request);
            case `restarting`:
                return url.pathname === VITALS_PATH
                    ? json(RESTARTING_VITALS)
                    : new Response(`the sandbox daemon is restarting`, { status: 503, headers: { "retry-after": `1` } });
            case `down`:
            case `fixing`:
            case `needs-you`:
            case `hosted`:
                return noTunnel();
        }
    };
