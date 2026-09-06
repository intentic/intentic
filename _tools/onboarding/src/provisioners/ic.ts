import { DAEMON_PORT } from "@intentic/constants";
import { waitForAnnounce } from "../announce.js";
import { findIcBinary } from "../ic-binary.js";
import type { Provisioner, ProvisionContext } from "../provisioner.js";
import { openRunTab } from "../run-step.js";
import { type Completed, freshShellEnv, runTool } from "../shell.js";

/* THE CLI PATH — the wizard's setup code, redeemed by THIS checkout's `ic sandbox connect`.
 *
 * This is the lane the desktop app and the terminal one-liner both end up in, and until it existed it was the
 * only onboarding path with no end-to-end coverage at all: the claim's values reach a container through a list
 * written once in Rust, and every layer around it is tested separately. That gap shipped. When reachability
 * moved to intentic's own edge, ic stopped passing the two values a daemon dials with and nothing noticed —
 * the platform minted them, the run contract replayed them, the daemon read them, and the CLI in the middle
 * dropped them on the floor. Installs came up healthy, registered with the platform, and answered 502 on their
 * own address forever.
 *
 * SO THE ASSERTION THAT MATTERS HERE IS `reachedBy`. A hermetic world has no edge (the grant names an
 * unroutable `.test` address on purpose; world.ts says why), so no tunnel can ever come up and asserting one
 * would be asserting a fiction. What IS knowable, and is exactly the fingerprint of that bug, is the POSTURE
 * the daemon reports on /health: `tunnel` means it was given a grant and an edge and is dialling, `loopback`
 * means it was given neither and never will be. One field, no log scraping, and no edge required.
 */

/* The setup code off the one-liner the wizard renders — `curl … | env … sh -s -- <code>`, or `env … sh
 * <path> <code>` when the page is handing out the checkout's own scripts.
 *
 * The command is not RUN: it fetches ic from the latest GitHub release (this lane drives the branch's binary,
 * for the reason images.ts builds the api rather than pulling `:latest`) and would prepare Docker on a machine
 * that already has it. What it carries is the code, and taking that from the bytes the page actually copies is
 * what keeps this honest about the command a user is given. */
const setupCodeOf = (command: string): string | undefined => /\bsh\s+(?:-s\s+--\s+)?(\S+)\s*$/u.exec(command.trim())?.[1];

/** The slug every later command keys off: the leading label of the address the daemon announced. */
const slugOf = (daemonUrl: string): string | undefined => {
    try {
        const label = new URL(daemonUrl).hostname.split(`.`)[0];
        return label === `` ? undefined : label;
    } catch {
        return undefined;
    }
};

/* THE LINKS THIS WORLD CANNOT ANSWER, and the only failure this lane tolerates.
 *
 * `ic sandbox connect` ends by verifying the whole reachability chain and fails a code-carrying setup when any
 * link is broken — which is right, and which a world with no edge cannot satisfy: the sandbox's public name is
 * under a reserved TLD that resolves nowhere. Those two links are therefore expected to fail HERE and nowhere
 * else. Every other link (the container, the daemon, its registration) is this tier's business, so a run that
 * fails one of them fails the lane — and so does a non-zero exit that names no link at all, which is a setup
 * that died somewhere this tolerance was never meant to cover. */
const OUTWARD_LINKS = new Set([`Public DNS`, `Public URL`]);

/** The check names out of ic's failure summary — its numbered `  1. Public DNS` lines and nothing else. */
const failedChecks = (output: string): string[] => [...output.matchAll(/^\s+\d+\.\s+(\S.*?)\s*$/gmu)].map((match) => match[1] ?? ``);

/** Whether a finished setup is one this world explains, or a failure to report with everything it printed. */
const tolerated = (setup: Completed): boolean => {
    if (setup.code === 0) {
        return true;
    }
    const failed = failedChecks(setup.output);
    return failed.length > 0 && failed.every((link) => OUTWARD_LINKS.has(link));
};

const SETUP_TIMEOUT_MS = 15 * 60_000;

export const icProvisioner = (): Provisioner => {
    let ic: string | undefined;
    let slug: string | undefined;

    /* THE CODE, OFF THE PAGE. The run step's own Copy button is the only `Copy` on screen while the terminal
     * tab is open (the compose tab's buttons render with the compose panel), and the command it copies is
     * guarded before anything is redeemed: the wizard writes a LOCAL platform into it only when the api is
     * served on loopback, and without that this run would spend its setup code on the real platform. */
    const readSetupCode = async (context: ProvisionContext, apiUrl: string): Promise<string> => {
        const { page } = context;
        /* The wizard opens with step 1 already done — the platform mints the sandbox and its address behind it
         * — so the RUN step is what this waits for, behind the fold the app-first page puts it and patiently,
         * both of which run-step.ts owns for the compose lane as well. */
        await openRunTab(page, /Linux \/ macOS/u, `Linux / macOS`);

        await page.getByRole(`button`, { name: `Copy`, exact: true }).first().click();
        const command = (await page.evaluate(() => navigator.clipboard.readText())).trim();
        if (command === ``) {
            throw new Error(`the wizard's Copy button copied nothing: it rendered an empty command`);
        }
        if (!command.includes(`PLATFORM_URL='${apiUrl}'`)) {
            throw new Error(
                `the wizard rendered a command that does not name this run's platform (${apiUrl}): running it would ` +
                    `redeem this setup code somewhere that is not ours. The command was: ${command}`,
            );
        }
        const code = setupCodeOf(command);
        if (code === undefined) {
            throw new Error(`the wizard's one-liner carries no setup code: ${command}`);
        }
        return code;
    };

    /* WHICH CONTAINER THIS SANDBOX IS, asked of Docker rather than composed from a naming rule this package
     * would then own a second copy of. Every later flow — recreate, cleanup, the desktop launcher — addresses
     * a sandbox by a name keyed on its slug, so a single running container carrying the slug IS the sandbox,
     * and two would mean a stray from an earlier run that the assertions below could pick at random. */
    const containerOf = async (sandboxSlug: string): Promise<string> => {
        const listed = await runTool(`docker`, [`ps`, `--filter`, `name=${sandboxSlug}`, `--format`, `{{.Names}}`], {
            env: freshShellEnv(),
            timeoutMs: 60_000,
        });
        const names = listed.output
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line.endsWith(sandboxSlug));
        if (names.length !== 1) {
            throw new Error(
                `expected exactly one running container named for ${sandboxSlug}, found ${names.length ? names.join(`, `) : `none`}. ` +
                    `The platform recorded an announce, so a daemon is running somewhere this lane cannot address.`,
            );
        }
        return names[0] ?? ``;
    };

    /* THE ASSERTION THIS LANE EXISTS FOR. `reachedBy` is the daemon's own account of how the world gets to it,
     * computed from the grant and the edge it was handed. Read from inside the container, so nothing about it
     * depends on an edge existing in this world. */
    const requireTunnelPosture = async (container: string): Promise<void> => {
        const health = await runTool(`docker`, [`exec`, container, `curl`, `-sf`, `--max-time`, `10`, `localhost:${DAEMON_PORT}/health`], {
            env: freshShellEnv(),
            timeoutMs: 60_000,
        });
        if (health.code !== 0) {
            throw new Error(`${container} did not answer /health after a setup that got this far:\n${health.output}`);
        }
        const { reachedBy } = JSON.parse(health.output) as { reachedBy?: string };
        if (reachedBy !== `tunnel`) {
            throw new Error(
                `the daemon reports it is reached by "${reachedBy}", not by a tunnel: the setup created a container that ` +
                    `dials no edge. That is what a dropped SANDBOX_GRANT or INGRESS_URL looks like from the inside — the box ` +
                    `is healthy, it registers with the platform, and its public address answers 502 for good.`,
            );
        }
    };

    return {
        name: `ic`,

        async standDown() {
            const found = await findIcBinary();
            if (`standDown` in found) {
                return found.standDown;
            }
            ic = found.path;
            return undefined;
        },

        async provision(context) {
            const { apiUrl, webUrl, databaseUrl } = context.world;
            if (ic === undefined || apiUrl === undefined || webUrl === undefined || databaseUrl === undefined) {
                throw new Error(`the CLI lane was provisioned without an ic binary or without a world — standDown() did not run`);
            }

            await context.page.goto(`${webUrl}/setup`);
            const code = await readSetupCode(context, apiUrl);

            // Stamped before the box is started, so the announce this waits for can only be this run's.
            const startedAt = new Date();
            const setup = await runTool(ic, [`sandbox`, `connect`, code, `-y`], {
                env: freshShellEnv({
                    // The claim, from the host. The container's own copy is derived from this one by ic, which
                    // rewrites loopback to `host.docker.internal` — the spelling the daemon trusts without a
                    // certificate it could never have been given (announce.ts's LOCAL_HOSTS).
                    PLATFORM_URL: apiUrl,
                    // The one browser origin that will call this daemon. Without it the box answers the
                    // workspace's very first request with a CORS refusal, which reads as a dead app.
                    WEB_ORIGIN: webUrl,
                    // The image CI just published, when it names one; otherwise the same `:stable` the
                    // wizard's own compose file pins.
                    SANDBOX_IMAGE: process.env[`SANDBOX_E2E_IMAGE`] ?? `ghcr.io/intentic/sandbox:stable`,
                }),
                timeoutMs: SETUP_TIMEOUT_MS,
            });
            if (!tolerated(setup)) {
                throw new Error(`ic sandbox connect exited ${setup.code} for a reason this world does not explain:\n${setup.output}`);
            }

            /* WAIT FOR THE PLATFORM'S REGISTRY, not for words on a screen — announce.ts says why the row is
             * the only honest gate, and it hands back the address the daemon claimed. */
            const announced = await waitForAnnounce(databaseUrl, startedAt, 300_000);
            slug = slugOf(announced.daemonUrl);
            if (slug === undefined) {
                throw new Error(`the platform recorded an unreadable daemon address for ${announced.id}: ${announced.daemonUrl}`);
            }
            await requireTunnelPosture(await containerOf(slug));
        },

        async teardown() {
            if (slug === undefined || ic === undefined) {
                return;
            }
            /* `ONBOARDING_KEEP=1` leaves the sandbox standing. Debugging this path means reading the daemon's
             * log and the container's environment, and both are gone the instant teardown runs. */
            if (process.env[`ONBOARDING_KEEP`] === `1`) {
                return;
            }
            // The product's own cleanup, which is also the command every failure in this flow points at: it
            // takes the container, its network and its volumes, so nothing outlives the run.
            await runTool(ic, [`sandbox`, `remove`, slug, `-y`], { env: freshShellEnv(), timeoutMs: 300_000 }).catch(() => undefined);
            slug = undefined;
        },
    };
};
