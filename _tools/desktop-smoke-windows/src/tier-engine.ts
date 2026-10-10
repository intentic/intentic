// Tier 4: Intentic's own container engine (a dockerd in a WSL distro of ours, _sandbox/ic/engine) on this Windows machine,
// beside the Docker Desktop the other tiers use. Installed from the rootfs this checkout built; a port a container
// publishes on 127.0.0.1 reached from Windows, which is what every sandbox's local address rides on and what WSL's
// mirrored networking broke until the engine's keeper learned of it (2026-10-09); and, on a deep run, a sandbox made on
// Docker Desktop, moved onto the engine with its files and back again. ic runs with a home, a disk and a distro of the
// tier's own (engine.ts), so nothing here touches this runner's own ~/.intentic, a real engine, or the Run key.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INGRESS_URL, PLATFORM_URL_UNREACHABLE, SANDBOX_GRANT } from "./constants.js";
import { ENGINE_CONNECT_TOKEN, ENGINE_SANDBOX_HOSTNAME, engineDockerOf, engineStatusOf, isolatedEnv, moveLines } from "./engine.js";
import type { Harness } from "./harness.js";
import { sandboxContainerName } from "./parse.js";
import { dockerReachable, sandboxHealth } from "./probe.js";
import { type RunResult, run } from "./run.js";

export interface EngineTierOptions {
    /** ic.exe built from this checkout. */
    readonly icBin: string;
    /** intentic-engine-<version>-x86_64.tar.gz built from this checkout (`build-intentic-engine.sh`). */
    readonly tarball: string;
    readonly sandboxImage: string;
    readonly webOrigin: string;
    /** The deep run's part: a sandbox moved onto the engine and back. Minutes, since the sandbox image crosses once. */
    readonly move: boolean;
}

/** Where the tier's isolated home and the engine's disk live; removed at the start and the end. */
export const ENGINE_ROOT = join(tmpdir(), `intentic-engine-smoke`);

const WEB = `intentic-engine-smoke-web`;
const WEB_IMAGE = `nginx:alpine`;
const WEB_PORT = 18_099;
const MARKER = `/work/intentic-engine-smoke.txt`;
const INSTALL_MS = 15 * 60_000;
const CONNECT_MS = 30 * 60_000;
const MOVE_MS = 40 * 60_000;

const said = (result: RunResult): string => `${result.stdout}\n${result.stderr}`.trim();

/** The status code a GET of `url` answers with from Windows itself, or undefined when nothing answered. */
const httpStatus = async (url: string): Promise<number | undefined> => {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        return response.status;
    } catch {
        return undefined;
    }
};

export const runEngineTier = async (harness: Harness, options: EngineTierOptions): Promise<void> => {
    harness.section(`what this tier runs`);
    for (const [what, path] of [
        [`ic.exe`, options.icBin],
        [`the engine's rootfs`, options.tarball],
    ] as const) {
        if (!existsSync(path)) {
            harness.fail(`no ${what} at ${path}`, `The Windows build job puts both into the artifact this workflow downloads.`);
            return;
        }
    }
    harness.pass(`ic.exe and the engine's rootfs from this checkout are here`);
    rmSync(ENGINE_ROOT, { recursive: true, force: true });
    mkdirSync(ENGINE_ROOT, { recursive: true });
    const env = isolatedEnv(ENGINE_ROOT, options.tarball);
    const ic = async (args: readonly string[], timeoutMs: number): Promise<RunResult> => await run(options.icBin, args, { env, timeoutMs });
    const status = async () => engineStatusOf((await ic([`engine`, `status`, `--json`], 60_000)).stdout);

    harness.section(`installed beside Docker Desktop`);
    const installed = await ic([`engine`, `install`], INSTALL_MS);
    if (installed.code !== 0) {
        harness.fail(`ic engine install exited ${installed.code}`, said(installed));
        return;
    }
    harness.pass(`ic engine install finished`);
    const after = await status();
    if (after?.installed === true && after.running) {
        harness.pass(`the engine is installed and answers`);
    } else {
        harness.fail(`the engine is not running after its install`, JSON.stringify(after));
        return;
    }
    // This runner's sandboxes run on Docker Desktop: an install must leave them there (the record's `active` switch).
    if (await dockerReachable()) {
        if (after.engine === `dockerDesktop` && !after.active) {
            harness.pass(`installed beside Docker Desktop, it switched nothing: Docker Desktop's sandboxes stay reachable`);
        } else {
            harness.fail(`the install switched this PC's docker onto the new engine`, JSON.stringify(after));
        }
    }

    harness.section(`a port published on 127.0.0.1 reaches Windows`);
    let record = ``;
    try {
        record = readFileSync(join(env[`USERPROFILE`] ?? ``, `.intentic`, `engine`, `engine.json`), `utf8`);
    } catch {
        // Read as unparsable below.
    }
    const engine = engineDockerOf(record);
    if (engine === undefined) {
        harness.fail(`the engine record does not say how to reach the engine`, record);
        return;
    }
    const docker = async (args: readonly string[], timeoutMs = 5 * 60_000): Promise<RunResult> =>
        await run(engine.docker, args, { env: { ...env, ...engine.env }, timeoutMs });
    await docker([`rm`, `-f`, WEB]);
    const web = await docker([`run`, `-d`, `--name`, WEB, `-p`, `127.0.0.1:${WEB_PORT}:80`, WEB_IMAGE]);
    if (web.code === 0) {
        harness.pass(`a container publishing 127.0.0.1:${WEB_PORT} runs on the engine`);
        await harness.untilTrue(30, `Windows reaches it at 127.0.0.1:${WEB_PORT}`, async () => (await httpStatus(`http://127.0.0.1:${WEB_PORT}/`)) === 200);
    } else {
        harness.fail(`the engine would not run ${WEB_IMAGE}`, said(web));
    }
    await docker([`rm`, `-f`, WEB]);

    if (options.move) {
        await moveBothWays(harness, { ic, status, docker, options, env });
    }

    harness.section(`removed`);
    const removed = await ic([`engine`, `remove`, `--yes`], 5 * 60_000);
    if (removed.code === 0) {
        harness.pass(`ic engine remove took the engine away`);
    } else {
        harness.fail(`ic engine remove exited ${removed.code}`, said(removed));
    }
};

interface MoveContext {
    readonly ic: (args: readonly string[], timeoutMs: number) => Promise<RunResult>;
    readonly status: () => Promise<ReturnType<typeof engineStatusOf>>;
    readonly docker: (args: readonly string[], timeoutMs?: number) => Promise<RunResult>;
    readonly options: EngineTierOptions;
    readonly env: Record<string, string>;
}

const moveBothWays = async (harness: Harness, context: MoveContext): Promise<void> => {
    const { ic, status, docker, options } = context;
    const container = sandboxContainerName(ENGINE_SANDBOX_HOSTNAME);

    harness.section(`a sandbox on Docker Desktop`);
    // The setup tier's stand-in inputs under a hostname of this tier's own; ic reads them from its environment, beside
    // the tier's isolated one.
    const connectEnv = {
        CONNECT_TOKEN: ENGINE_CONNECT_TOKEN,
        SANDBOX_GRANT,
        INGRESS_URL,
        SANDBOX_HOSTNAME: ENGINE_SANDBOX_HOSTNAME,
        SANDBOX_IMAGE: options.sandboxImage,
        PLATFORM_URL: PLATFORM_URL_UNREACHABLE,
        WEB_ORIGIN: options.webOrigin,
    };
    const made = await run(options.icBin, [`sandbox`, `connect`, `-y`], { env: { ...context.env, ...connectEnv }, timeoutMs: CONNECT_MS });
    if (made.code !== 0) {
        harness.fail(`ic sandbox connect exited ${made.code}`, said(made));
        return;
    }
    if ((await sandboxHealth(container)) === undefined) {
        harness.fail(`${container} does not answer /health on Docker Desktop`);
        return;
    }
    harness.pass(`${container} answers on Docker Desktop`);
    const stamp = `moved ${Date.now()}`;
    const wrote = await run(`docker`, [`exec`, container, `sh`, `-c`, `printf '%s' '${stamp}' > ${MARKER}`]);
    if (wrote.code !== 0) {
        harness.fail(`could not write a file into the sandbox`, said(wrote));
        return;
    }

    harness.section(`moved onto Intentic's engine`);
    const there = await ic([`engine`, `move`, `--to`, `intentic`, `--yes`], MOVE_MS);
    const steps = moveLines(there.stdout).map((line) => String(line[`step`]));
    if (there.code === 0 && steps.includes(`done`)) {
        harness.pass(`ic engine move --to intentic finished (${steps.filter((step) => step === `moved`).length} moved)`);
    } else {
        harness.fail(`ic engine move --to intentic exited ${there.code}`, said(there));
        return;
    }
    const onOurs = await status();
    if (onOurs?.engine === `intentic` && onOurs.active) {
        harness.pass(`this PC now runs its sandboxes on Intentic's engine`);
    } else {
        harness.fail(`the move did not switch the PC`, JSON.stringify(onOurs));
    }
    const carried = await docker([`exec`, container, `cat`, MARKER]);
    if (carried.code === 0 && carried.stdout.trim() === stamp) {
        harness.pass(`the file written on Docker Desktop is in the sandbox on Intentic's engine`);
    } else {
        harness.fail(`the sandbox on Intentic's engine does not hold the file written before the move`, said(carried));
    }
    const port = (await docker([`port`, container])).stdout.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (port === undefined) {
        harness.fail(`the moved sandbox publishes no loopback port`);
    } else {
        await harness.untilTrue(120, `Windows reaches the moved sandbox's daemon at 127.0.0.1:${port}`, async () => (await httpStatus(`http://127.0.0.1:${port}/health`)) === 200);
    }

    harness.section(`moved back to Docker Desktop`);
    const back = await ic([`engine`, `move`, `--to`, `docker-desktop`, `--yes`], MOVE_MS);
    if (back.code === 0) {
        harness.pass(`ic engine move --to docker-desktop finished`);
    } else {
        harness.fail(`ic engine move --to docker-desktop exited ${back.code}`, said(back));
        return;
    }
    const home = await run(`docker`, [`exec`, container, `cat`, MARKER]);
    if (home.code === 0 && home.stdout.trim() === stamp) {
        harness.pass(`the file came back to Docker Desktop with the sandbox`);
    } else {
        harness.fail(`the sandbox back on Docker Desktop does not hold the file`, said(home));
    }
    const cleaned = await ic([`engine`, `cleanup`, `--now`], 5 * 60_000);
    if (cleaned.code === 0) {
        harness.pass(`the copies the moves left behind are removed`);
    } else {
        harness.fail(`ic engine cleanup --now exited ${cleaned.code}`, said(cleaned));
    }
};
