import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Where a folder's search runs: ripgrep, the engine the sandbox's own search runs (iq's `find`), started beside the
// files rather than reading them across a boundary. A folder in a WSL distro, which Windows reaches through
// \\wsl.localhost\<distro>, is searched by a Linux rg inside that distro: across the share every file is a round trip,
// and a repository of 10,745 files took 37 s to read from the Windows side and 132 ms from inside the distro (measured
// 2026-10-17 on the owner's PC). Every other folder is searched by this computer's own rg. With no rg to run, the
// caller reads the folder itself (search.ts).

// The rg binaries the app ships (`--search-tools`, staged by stage-local-files.sh): this computer's own, and on Windows
// a static Linux build for folders in a WSL distro.
export interface SearchTools {
    readonly native?: string | undefined;
    readonly linux?: string | undefined;
}

// The tools in `dir` (the app's), with the rg on PATH standing in for a native one the app did not ship (a dev build,
// a platform the app ships none for). Only Windows reaches folders inside a WSL distro, so only it looks for a Linux rg.
export const searchToolsIn = (
    dir: string | undefined,
    platform: NodeJS.Platform = process.platform,
    onPath: string | undefined = Bun.which(`rg`) ?? undefined,
): SearchTools => {
    const shipped = (name: string): string | undefined => (dir !== undefined && existsSync(join(dir, name)) ? join(dir, name) : undefined);
    const windows = platform === `win32`;
    return { native: shipped(windows ? `rg.exe` : `rg`) ?? onPath, linux: windows ? shipped(`rg-linux`) : undefined };
};

// Where a folder's files are: on this computer's own disks, or inside a WSL distro, at that distro's own path.
export type Place = { readonly kind: `native` } | { readonly kind: `wsl`; readonly distro: string; readonly path: string };

// `\\wsl.localhost\<distro>\…` and the older `\\wsl$\<distro>\…`, either slash, with or without the `\\?\UNC\` prefix a
// real path can come back with.
const WSL_SHARE = /^(?:[\\/]{2}\?[\\/]UNC[\\/]|[\\/]{2})(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i;

export const placeOf = (root: string, platform: NodeJS.Platform = process.platform): Place => {
    const share = platform === `win32` ? WSL_SHARE.exec(root) : null;
    if (share === null) {
        return { kind: `native` };
    }
    const rest = (share[2] ?? ``).split(/[\\/]+/).filter((segment) => segment !== ``);
    return { kind: `wsl`, distro: share[1] ?? ``, path: `/${rest.join(`/`)}` };
};

// How one run of rg ended: its exit code, null when this side stopped it. What it says on stderr is never read: its
// wording is rg's to change, and the code says what a caller needs (0 found, 1 found nothing, 2 an error).
export interface RgExit {
    readonly code: number | null;
}

// Runs rg over a folder, its stdout handed over a line at a time; `onLine` answering false stops it. Undefined when no
// rg could run there at all: none shipped or on PATH, or the distro's route refused (wsl.exe exits with its own code,
// which is never one of rg's 0, 1 and 2).
export type Ripgrep = (
    root: string,
    args: readonly string[],
    onLine: (line: string) => boolean,
    signal?: AbortSignal | undefined,
) => Promise<RgExit | undefined>;

interface Invocation {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
}

type Ran = { readonly ran: true; readonly exit: RgExit } | { readonly ran: false };

const runOnce = (invocation: Invocation, onLine: (line: string) => boolean, signal: AbortSignal | undefined): Promise<Ran> =>
    new Promise((resolve) => {
        // No console window flashing up for a search: the app starts this process with none of its own.
        const child = spawn(invocation.command, [...invocation.args], { cwd: invocation.cwd, stdio: [`pipe`, `pipe`, `ignore`], windowsHide: true });
        child.stdin.end();
        let stopped = false;
        let lined = false;
        let carry = ``;
        const stop = (): void => {
            if (!stopped) {
                stopped = true;
                child.kill();
            }
        };
        const take = (line: string): void => {
            if (stopped || line === ``) {
                return;
            }
            lined = true;
            if (!onLine(line)) {
                stop();
            }
        };
        signal?.addEventListener(`abort`, stop, { once: true });
        child.stdout.setEncoding(`utf8`);
        child.stdout.on(`data`, (chunk: string) => {
            const lines = (carry + chunk).split(`\n`);
            carry = lines.pop() ?? ``;
            for (const line of lines) {
                take(line.endsWith(`\r`) ? line.slice(0, -1) : line);
            }
        });
        // A binary that is not there, or may not run: nothing ran, and the next way is tried.
        child.on(`error`, () => {
            signal?.removeEventListener(`abort`, stop);
            resolve({ ran: false });
        });
        child.on(`close`, (code) => {
            signal?.removeEventListener(`abort`, stop);
            take(carry);
            if (stopped) {
                resolve({ ran: true, exit: { code: null } });
                return;
            }
            // rg's own codes; anything else is the route to it failing (wsl.exe's -1), unless rg had already answered.
            resolve(code === 0 || code === 1 || code === 2 || lined ? { ran: true, exit: { code } } : { ran: false });
        });
    });

// The Linux rg's path as a distro sees the Windows one (`/mnt/c/…`, or wherever its automount puts drives), asked once
// per distro of the distro's own `wslpath`. A refusal is not remembered: the distro may only have been starting.
const linuxPaths = new Map<string, Promise<string | undefined>>();

const linuxPathIn = (distro: string, windowsPath: string): Promise<string | undefined> => {
    const key = `${distro.toLowerCase()}\0${windowsPath}`;
    let asked = linuxPaths.get(key);
    if (asked === undefined) {
        let said = ``;
        asked = runOnce({ command: `wsl.exe`, args: [`-d`, distro, `--exec`, `wslpath`, `-u`, windowsPath] }, (line) => {
            said ||= line.trim();
            return true;
        }, undefined).then((ran) => (ran.ran && ran.exit.code === 0 && said.startsWith(`/`) ? said : undefined));
        linuxPaths.set(key, asked);
        void asked.then((path) => {
            if (path === undefined) {
                linuxPaths.delete(key);
            }
        });
    }
    return asked;
};

// The ways rg can run over `root`, best first: inside its distro, then this computer's own across the share.
const invocationsFor = async (tools: SearchTools, root: string, args: readonly string[], platform: NodeJS.Platform): Promise<Invocation[]> => {
    const ways: Invocation[] = [];
    const place = placeOf(root, platform);
    if (place.kind === `wsl` && tools.linux !== undefined) {
        const linux = await linuxPathIn(place.distro, tools.linux);
        if (linux !== undefined) {
            ways.push({ command: `wsl.exe`, args: [`-d`, place.distro, `--cd`, place.path, `--exec`, linux, ...args] });
        }
    }
    if (tools.native !== undefined) {
        ways.push({ command: tools.native, args, cwd: root });
    }
    return ways;
};

export const ripgrepWith =
    (tools: SearchTools, platform: NodeJS.Platform = process.platform): Ripgrep =>
    async (root, args, onLine, signal) => {
        for (const way of await invocationsFor(tools, root, args, platform)) {
            const ran = await runOnce(way, onLine, signal);
            if (ran.ran) {
                return ran.exit;
            }
        }
        return undefined;
    };
