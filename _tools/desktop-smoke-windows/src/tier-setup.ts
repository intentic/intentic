/* TIER 2, does the setup the app runs actually GO THROUGH, on a real Windows machine?
 *
 * The counterpart of `_tools/scripts/desktop/verify-desktop-setup.sh`, and it splits the setup journey the same way
 * that file does:
 *
 *   • WHAT THE APP PASSES, the argv and env assembly, including the sh-positional / ps1-named divergence that
 *     silently misbinds. Unit-tested in the desktop crate; costs milliseconds; both hosts. Already covered.
 *   • WHAT THE SCRIPT THEN DOES, probe Docker, fetch the CLI, pull the image, run the container, wire the
 *     network, wait on /health. That is this file. On Linux it needed a real Docker daemon and so runs nightly;
 *     on Windows it needs a real WINDOWS daemon, which is the entire reason this tier could not exist before.
 *
 * THE SCRIPT IS THE INSTALLED ONE, not the one in the source tree. `verify-desktop-bundle.sh` proves the
 * bundled bytes match the source; tier 1 proves the install puts those bytes on the machine; this runs exactly
 * them. Reading `_site/site/public/scripts/connect.ps1` here would test a file no user ever runs, and on
 * Windows that gap is wider than on Linux, because the installer is cross-built and its resource copy is the
 * step nobody has ever watched happen.
 *
 * IT IS SPAWNED THE WAY THE APP SPAWNS IT, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <path>`.
 * Windows PowerShell 5.1, not pwsh 7: that is what the app runs and what the site's one-liner lands in, and the
 * two differ in exactly the places these scripts live.
 *
 * HERMETIC, no edge, no Google, no platform. `connect.ps1` documents a direct-token path (CONNECT_TOKEN +
 * SANDBOX_GRANT + SANDBOX_HOSTNAME instead of a setup code), which is what makes that possible: the platform
 * only mints a reachability grant when it holds a signing key, so a code-claiming run cannot be secret-free.
 * The grant here is a dummy naming an unroutable ingress, so the daemon's tunnel dial fails and retries
 * harmlessly; the entrypoint does not gate the daemon on it, and the daemon is reached on the container's own
 * port.
 *
 * What this therefore does NOT cover: the setup-code claim round trip against a real platform. That needs a
 * real hub grant and belongs with the other gated nightly suites, which self-skip without their secrets.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONNECT_TOKEN, INGRESS_URL, PLATFORM_URL_UNREACHABLE, PRODUCT_NAME, SANDBOX_GRANT, SANDBOX_HOSTNAME } from "./constants.js";
import type { Harness } from "./harness.js";
import { sandboxContainerName } from "./parse.js";
import { dockerContainerOs, dockerInspectRunning, dockerLogs, dockerReachable, findInstalledApp, sandboxHealth } from "./probe.js";
import { run } from "./run.js";

export interface SetupTierOptions {
    /** The sandbox image the setup should pull. CI points this at the freshly published one. */
    readonly sandboxImage: string;
    /** The `ic.exe` built from THIS checkout, handed to the shim through its own local-dev override. */
    readonly icBin: string | undefined;
    /** Where the daemon should believe the web app lives, only ever read back as a CORS allowlist entry here. */
    readonly webOrigin: string;
}

/* connect.ps1 is a bootstrap shim: the flow lives in the `ic` CLI, which the shim downloads from the LATEST
 * GitHub Release. This tier verifies THIS COMMIT's flow, and before the first release carrying ic there is
 * nothing to download at all, so CI cross-builds ic from the same checkout the installer was built from and
 * hands it in via IC_BIN, the shim's own local-dev override. Exactly what the Linux tier does. */
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

    // ── Docker, and the question the shipped scripts do not ask ─────────────────────────────────────────
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
        // Named, not tolerated. A sandbox is a Linux container; a Windows-mode daemon answers every probe the
        // shipped scripts make and then fails the image pull with a manifest error that names no remedy.
        harness.fail(
            `the daemon runs ${containerOs ?? `unknown`} containers, not linux`,
            `A sandbox is a Linux container. Switch Docker Desktop to Linux containers (tray icon > "Switch to Linux containers"), or start it with the WSL2 backend.`,
        );
        return undefined;
    }
    harness.pass(`the daemon runs linux containers`);

    /* ── the prerequisite examination, on a machine that has nothing wrong with it ──────────────────────
     *
     * `ic docker prepare` reads a dozen facts off this PC. WMI classes, service names, registry values,
     * `wsl --status`, and decides from them whether a sandbox can run here. Every one of those is a name that
     * only exists on Windows, and the binary is cross-built on Linux, so nothing before this line has ever
     * executed a single one of them.
     *
     * `--dry-run` on a machine this tier has just confirmed is healthy therefore asserts the strongest thing
     * available cheaply: the probe runs, its output parses, and the classifier finds NOTHING. A renamed field
     * or a probe that silently returns nothing would fail here as a fistful of imaginary problems, which is
     * exactly how it would reach a user, except that they would meet it on a machine that really was fine. */
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

        /* ── AND IT MUST END, ON A RUN WITH NOBODY TO ASK ──────────────────────────────────────────────
         *
         * The failure this guards against is the worst one this flow has: not a wrong answer, but no answer.
         * `ic docker prepare` asks for consent before it changes anything, and it decides whether there is
         * somebody to ask by probing for a terminal. The desktop app spawns it from a GUI process with no
         * window, no console and closed stdin, and a prompt that reaches nobody, on a path where nothing
         * times out, is an install that never finishes in front of a user watching a spinner.
         *
         * `execFileAsync` with `windowsHide` gives exactly that shape: hidden console, piped stdio, no
         * stdin. So this runs the REAL consent path (no `--dry-run`, no `-y`) under it, and asserts only
         * that it came back. The code it comes back with depends on the machine: 0 where nothing is wrong,
         * 3 where something is and it stopped to ask (docs/cli-output-protocol.md §2c), and both are
         * answers. A timeout is not.
         *
         * Two minutes is far longer than the examination takes and far shorter than "forever", which is the
         * only other outcome available if this ever regresses. */
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

    // ── run the setup the app would run ─────────────────────────────────────────────────────────────────
    harness.section(`the shipped connect.ps1 (image: ${options.sandboxImage})`);
    const env: Record<string, string> = {
        CONNECT_TOKEN,
        SANDBOX_GRANT,
        INGRESS_URL,
        SANDBOX_HOSTNAME,
        SANDBOX_IMAGE: options.sandboxImage,
        // Pointed at the unroutable reserved TLD precisely because nothing on this path should call it, a claim
        // attempt fails loudly instead of quietly reaching production.
        PLATFORM_URL: PLATFORM_URL_UNREACHABLE,
        WEB_ORIGIN: options.webOrigin,
    };
    if (options.icBin !== undefined) {
        env[`IC_BIN`] = options.icBin;
    }

    const setup = await run(
        `powershell.exe`,
        // The app's own invocation, verbatim (scripts.rs): -File so the script's parameters bind normally, and
        // the policy bypass scoped to this process. -Yes is the named form, a bare positional would bind to
        // -PlatformUrl and point the whole setup at a platform named after a setup code.
        [`-NoProfile`, `-ExecutionPolicy`, `Bypass`, `-File`, script, `-Yes`],
        { env, timeoutMs: SETUP_TIMEOUT_MS },
    );
    if (setup.code === 0) {
        harness.pass(`connect.ps1 completed: its own gate is a wait on the daemon's /health`);
    } else {
        harness.fail(`connect.ps1 exited ${setup.code}`, `${setup.stdout}\n${setup.stderr}`);
        return undefined;
    }

    // ── independent read-back ───────────────────────────────────────────────────────────────────────────
    // connect's success already implies a healthy daemon, so these assert what its exit code does not: that the
    // container is named the way every later flow addresses it (recreate, cleanup and the launcher's docker
    // reads all key off `intentic-sandbox-<slug>`), and that the daemon identifies itself.
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
    return container;
};
