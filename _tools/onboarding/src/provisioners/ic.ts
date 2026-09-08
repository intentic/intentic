import { DAEMON_PORT } from "@intentic/constants";
import { waitForAnnounce } from "../announce.js";
import { findIcBinary } from "../ic-binary.js";
import type { Provisioner, ProvisionContext } from "../provisioner.js";
import { openRunTab } from "../run-step.js";
import { type Completed, freshShellEnv, runTool } from "../shell.js";

// Redeems the wizard's setup code with this checkout's `ic sandbox connect`, the coverage the desktop app and one-liner
// lane previously had none of. Asserts `reachedBy` from /health (tunnel vs loopback), since a hermetic world has no
// edge to tunnel through, but a dropped dial value is what leaves a container healthy yet unreachable.

// Extracts the setup code from the wizard's one-liner (`curl | sh -s -- <code>` or `sh <path> <code>`); the command
// itself is never run, only parsed for the code the page actually copied.
const setupCodeOf = (command: string): string | undefined => /\bsh\s+(?:-s\s+--\s+)?(\S+)\s*$/u.exec(command.trim())?.[1];

/** Slug every later command keys off: the leading label of the announced daemon address. */
const slugOf = (daemonUrl: string): string | undefined => {
    try {
        const label = new URL(daemonUrl).hostname.split(`.`)[0];
        return label === `` ? undefined : label;
    } catch {
        return undefined;
    }
};

// Only links expected to fail in a world with no edge; any other failing link fails the lane.
const OUTWARD_LINKS = new Set([`Public DNS`, `Public URL`]);

/** Check names from ic's failure summary's numbered ` 1. Public DNS` lines. */
const failedChecks = (output: string): string[] => [...output.matchAll(/^\s+\d+\.\s+(\S.*?)\s*$/gmu)].map((match) => match[1] ?? ``);

/** Whether a finished setup is one this world explains, or a real failure to report in full. */
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

    // Only `Copy` button on screen while the terminal tab is open. Guarded before redeeming: the wizard writes a local
    // platform into the command only when the api is on loopback.
    const readSetupCode = async (context: ProvisionContext, apiUrl: string): Promise<string> => {
        const { page } = context;
        // Step 1 is already done (sandbox minted); this waits on the RUN step, rendered behind a fold.
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

    // Asks Docker which container this sandbox is, rather than deriving a name this package would then own a second
    // copy of. Exactly one running container should carry the slug; two means a stray from an earlier run.
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

    // The assertion this lane exists for: reachedBy is the daemon's own account of how it's reached, computed from its
    // grant and edge. Read from inside the container, so it needs no edge to exist in this world.
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
                    // Host's claim; ic rewrites loopback to host.docker.internal, which the daemon trusts uncertified.
                    PLATFORM_URL: apiUrl,
                    // Only browser origin allowed to call this daemon; without it the first request gets a CORS
                    // refusal.
                    WEB_ORIGIN: webUrl,
                    // CI's just-published image if named; otherwise `:stable`, matching the wizard's own compose file.
                    SANDBOX_IMAGE: process.env[`SANDBOX_E2E_IMAGE`] ?? `ghcr.io/intentic/sandbox:stable`,
                }),
                timeoutMs: SETUP_TIMEOUT_MS,
            });
            if (!tolerated(setup)) {
                throw new Error(`ic sandbox connect exited ${setup.code} for a reason this world does not explain:\n${setup.output}`);
            }

            // Waits on the platform's registry, not screen text; returns the address the daemon claimed.
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
            // ONBOARDING_KEEP=1 leaves the sandbox up, so the daemon log and container env survive for debugging.
            if (process.env[`ONBOARDING_KEEP`] === `1`) {
                return;
            }
            // Product's own cleanup: removes the container, network and volumes so nothing outlives the run.
            await runTool(ic, [`sandbox`, `remove`, slug, `-y`], { env: freshShellEnv(), timeoutMs: 300_000 }).catch(() => undefined);
            slug = undefined;
        },
    };
};
