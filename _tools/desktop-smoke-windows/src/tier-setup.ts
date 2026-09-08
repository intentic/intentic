// Tier 2: whether connect.ps1's setup completes on a real Windows Docker daemon (the app's argv/env is unit-tested
// elsewhere). Runs the INSTALLED script, spawned the way the app spawns it. Hermetic: a dummy grant to an unroutable
// ingress fails the tunnel dial harmlessly, since the daemon answers on its own container port.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONNECT_TOKEN, INGRESS_URL, PLATFORM_URL_UNREACHABLE, PRODUCT_NAME, SANDBOX_GRANT, SANDBOX_HOSTNAME } from "./constants.js";
import type { Harness } from "./harness.js";
import { sandboxContainerName } from "./parse.js";
import { dockerContainerOs, dockerInspectRunning, dockerLogs, dockerReachable, findInstalledApp, missingContainerEnv, sandboxHealth } from "./probe.js";
import { run } from "./run.js";

export interface SetupTierOptions {
    /** Sandbox image the setup should pull; CI points this at the freshly published one. */
    readonly sandboxImage: string;
    /** ic.exe built from this checkout, handed to the shim through its own local-dev override. */
    readonly icBin: string | undefined;
    /** Where the daemon should believe the web app lives; read back only as a CORS allowlist entry. */
    readonly webOrigin: string;
}

// Before ic's first release, CI cross-builds it from this checkout, passed in via IC_BIN, the shim's override.
const SETUP_TIMEOUT_MS = 30 * 60 * 1_000;

export const runSetupTier = async (harness: Harness, options: SetupTierOptions): Promise<string | undefined> => {
    const installed = await findInstalledApp(PRODUCT_NAME);
    if (installed === undefined) {
        harness.fail(
            `${PRODUCT_NAME} is not installed`,
            `This tier runs the scripts the INSTALLER put on the machine. Run the install tier first with --keep-installed.`,
        );
        return undefined;
    }

    const script = join(installed.installLocation, `scripts`, `connect.ps1`);
    if (!existsSync(script)) {
        harness.fail(`the installed app has no scripts\\connect.ps1`, `Looked in ${installed.installLocation}.`);
        return undefined;
    }

    // docker, and the question the shipped scripts do not ask
    harness.section(`docker`);
    if (!(await dockerReachable())) {
        harness.fail(
            `no Docker daemon answers`,
            `Docker Desktop has to be running and signed in before this tier. On a fresh snapshot it can take a minute after login.`,
        );
        return undefined;
    }
    harness.pass(`a Docker daemon answers`);

    const containerOs = await dockerContainerOs();
    if (containerOs !== `linux`) {
        // Named, not tolerated: a Windows-mode daemon answers every probe and then fails the image pull.
        harness.fail(
            `the daemon runs ${containerOs ?? `unknown`} containers, not linux`,
            `A sandbox is a Linux container. Switch Docker Desktop to Linux containers (tray icon > "Switch to Linux containers"), or start it with the WSL2 backend.`,
        );
        return undefined;
    }
    harness.pass(`the daemon runs linux containers`);

    // `ic docker prepare` reads Windows-only facts (WMI, services, registry, wsl --status) nothing before this line has
    // run, since the binary is cross-built on Linux. --dry-run here should find nothing wrong.
    if (options.icBin !== undefined) {
        harness.section(`ic docker prepare (read-only)`);
        const prepared = await run(options.icBin, [`docker`, `prepare`, `--dry-run`], { timeoutMs: 120_000 });
        if (prepared.code === 0) {
            harness.pass(`it finds this PC ready`);
        } else {
            harness.fail(
                `ic docker prepare --dry-run exited ${prepared.code} on a PC whose Docker this tier just verified`,
                `Either the machine really is missing something, or the Windows probe is misreading it: the checklist below says which.\n${prepared.stdout}\n${prepared.stderr}`,
            );
            return undefined;
        }

        // Reproduces the app's own no-console, no-stdin spawn, where an unheard prompt would hang forever. Asserts only
        // a prompt return of 0 (nothing to do) or 3 (stopped to ask); a timeout is the wrong answer.
        harness.section(`ic docker prepare (no terminal to ask on)`);
        const NEEDS_CONSENT = 3;
        const asked = await run(options.icBin, [`docker`, `prepare`], {
            timeoutMs: 120_000,
            env: { INTENTIC_NO_PROMPT: `1` },
        });
        if (asked.code === 0 || asked.code === NEEDS_CONSENT) {
            harness.pass(`it answers rather than waiting for a question nobody can hear (exit ${asked.code})`);
        } else {
            harness.fail(
                `ic docker prepare exited ${asked.code} with no terminal available`,
                `Expected 0 (nothing to do) or ${NEEDS_CONSENT} (stopped to ask). Anything else: especially a timeout, is the shape of an install that hangs in the desktop app.\n${asked.stdout}\n${asked.stderr}`,
            );
            return undefined;
        }
    }

    // run the setup the app would run
    harness.section(`the shipped connect.ps1 (image: ${options.sandboxImage})`);
    const env: Record<string, string> = {
        CONNECT_TOKEN,
        SANDBOX_GRANT,
        INGRESS_URL,
        SANDBOX_HOSTNAME,
        SANDBOX_IMAGE: options.sandboxImage,
        // Unroutable reserved TLD on purpose: a claim attempt fails loudly instead of quietly reaching production.
        PLATFORM_URL: PLATFORM_URL_UNREACHABLE,
        WEB_ORIGIN: options.webOrigin,
    };
    if (options.icBin !== undefined) {
        env[`IC_BIN`] = options.icBin;
    }

    const setup = await run(
        `powershell.exe`,
        // App's own invocation, verbatim: -Yes is named, since a bare positional would bind to -PlatformUrl instead.
        [`-NoProfile`, `-ExecutionPolicy`, `Bypass`, `-File`, script, `-Yes`],
        { env, timeoutMs: SETUP_TIMEOUT_MS },
    );
    if (setup.code === 0) {
        harness.pass(`connect.ps1 completed: its own gate is a wait on the daemon's /health`);
    } else {
        harness.fail(`connect.ps1 exited ${setup.code}`, `${setup.stdout}\n${setup.stderr}`);
        return undefined;
    }

    return readBack(harness);
};

// What connect's exit code doesn't say: the container is named the way later flows address it, the daemon identifies
// itself, and what was handed to the script reached the container.
const readBack = async (harness: Harness): Promise<string | undefined> => {
    harness.section(`read-back`);
    const container = sandboxContainerName(SANDBOX_HOSTNAME);
    if (await dockerInspectRunning(container)) {
        harness.pass(`${container} is running`);
    } else {
        harness.fail(`no running container named ${container}`, `The slug rule the app's launcher relies on has changed.`);
        return undefined;
    }

    const health = await sandboxHealth(container);
    if (health === undefined) {
        harness.fail(`the daemon does not answer /health`, await dockerLogs(container, 50));
        return undefined;
    }
    harness.pass(`the daemon answers /health: ${health}`);

    // Every check above passes on a sandbox given no reachability at all, since its tunnel dial is invisible from here.
    // Checks only that the values arrived, since the dial itself can't be proven without a real edge.
    const missing = await missingContainerEnv(container, [`SANDBOX_GRANT`, `INGRESS_URL`]);
    if (missing.length > 0) {
        harness.fail(
            `the container carries no ${missing.join(` and `)}`,
            `This tier passed ${missing.length === 1 ? `it` : `them`} to connect.ps1, so the value was dropped between the environment and the docker run. A sandbox without it dials no tunnel: it comes up healthy, registers with the platform, and its public address answers 502 for good.`,
        );
        return undefined;
    }
    harness.pass(`the container carries the grant and the edge it dials`);
    return container;
};
