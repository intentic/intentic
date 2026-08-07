/* TIER 2 — does the setup the app runs actually GO THROUGH, on a real Windows machine?
 *
 * The counterpart of `_tools/scripts/verify-desktop-setup.sh`, and it splits the setup journey the same way
 * that file does:
 *
 *   • WHAT THE APP PASSES — the argv and env assembly, including the sh-positional / ps1-named divergence that
 *     silently misbinds. Unit-tested in the desktop crate; costs milliseconds; both hosts. Already covered.
 *   • WHAT THE SCRIPT THEN DOES — probe Docker, fetch the CLI, pull the image, run the container, wire the
 *     network, wait on /health. That is this file. On Linux it needed a real Docker daemon and so runs nightly;
 *     on Windows it needs a real WINDOWS daemon, which is the entire reason this tier could not exist before.
 *
 * THE SCRIPT IS THE INSTALLED ONE, not the one in the source tree. `verify-desktop-bundle.sh` proves the
 * bundled bytes match the source; tier 1 proves the install puts those bytes on the machine; this runs exactly
 * them. Reading `_site/site/public/scripts/connect.ps1` here would test a file no user ever runs — and on
 * Windows that gap is wider than on Linux, because the installer is cross-built and its resource copy is the
 * step nobody has ever watched happen.
 *
 * IT IS SPAWNED THE WAY THE APP SPAWNS IT — `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <path>`.
 * Windows PowerShell 5.1, not pwsh 7: that is what the app runs and what the site's one-liner lands in, and the
 * two differ in exactly the places these scripts live.
 *
 * HERMETIC — no Cloudflare, no Google, no platform. `connect.ps1` documents a direct-token path (CONNECT_TOKEN
 * + TUNNEL_TOKEN + SANDBOX_HOSTNAME instead of a setup code), which is what makes that possible: the platform
 * only mints a tunnel when it has a Cloudflare pool configured, so a code-claiming run cannot be secret-free.
 * The cloudflared sidecar starts with a dummy token and flaps harmlessly; connect does not wait on it, and the
 * daemon is reached on the container's own port.
 *
 * What this therefore does NOT cover: the setup-code claim round trip against a real platform. That needs a
 * Cloudflare token and belongs with the other gated nightly suites, which self-skip without their secrets.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONNECT_TOKEN, PLATFORM_URL_UNREACHABLE, PRODUCT_NAME, SANDBOX_HOSTNAME, TUNNEL_TOKEN } from "./constants.js";
import type { Harness } from "./harness.js";
import { sandboxContainerName } from "./parse.js";
import { dockerContainerOs, dockerInspectRunning, dockerLogs, dockerReachable, findInstalledApp, sandboxHealth } from "./probe.js";
import { run } from "./run.js";

export interface SetupTierOptions {
    /** The sandbox image the setup should pull. CI points this at the freshly published one. */
    readonly sandboxImage: string;
    /** The `ic.exe` built from THIS checkout, handed to the shim through its own local-dev override. */
    readonly icBin: string | undefined;
    /** Where the daemon should believe the web app lives — only ever read back as a CORS allowlist entry here. */
    readonly webOrigin: string;
}

/* connect.ps1 is a bootstrap shim: the flow lives in the `ic` CLI, which the shim downloads from the LATEST
 * GitHub Release. This tier verifies THIS COMMIT's flow — and before the first release carrying ic there is
 * nothing to download at all — so CI cross-builds ic from the same checkout the installer was built from and
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

    // ── run the setup the app would run ─────────────────────────────────────────────────────────────────
    harness.section(`the shipped connect.ps1 (image: ${options.sandboxImage})`);
    const env: Record<string, string> = {
        CONNECT_TOKEN,
        TUNNEL_TOKEN,
        SANDBOX_HOSTNAME,
        SANDBOX_IMAGE: options.sandboxImage,
        // Pointed at the unroutable reserved TLD precisely because nothing on this path should call it — a claim
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
        // the policy bypass scoped to this process. -Yes is the named form — a bare positional would bind to
        // -PlatformUrl and point the whole setup at a platform named after a setup code.
        [`-NoProfile`, `-ExecutionPolicy`, `Bypass`, `-File`, script, `-Yes`],
        { env, timeoutMs: SETUP_TIMEOUT_MS },
    );
    if (setup.code === 0) {
        harness.pass(`connect.ps1 completed — its own gate is a wait on the daemon's /health`);
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
