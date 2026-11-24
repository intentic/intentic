import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// WHERE A FOLDER'S AGENTS RUN. A harness is started beside the files it works on: on this computer's own side, or
// inside the WSL distro that holds the folder (`\\wsl.localhost\<distro>\…`), where the reader's tools and their
// harness's sign-in for that folder live. The same split the folder's search makes (local-files ripgrep.ts), for the
// same reason: a Windows process working a distro's files crosses the share on every read, and runs none of the
// distro's own toolchain.
//
// A harness is not run in the bare environment a desktop app is started with. A program started from a dock or a
// start menu never read the reader's shell profile, so it lacks what their terminal has: the PATH entries a version
// manager adds, the variables a toolchain needs. Each place asks the reader's own login shell for its environment
// once (`parseEnvironment`) and every program there is started with it, so an agent finds the tools a terminal would.

export type Place = { readonly kind: `native` } | { readonly kind: `wsl`; readonly distro: string; readonly path: string };

export const placeKey = (place: Place): string => (place.kind === `native` ? `native` : `wsl:${place.distro.toLowerCase()}`);

export interface Ran {
    // Null for a program that never ran, or one this side stopped.
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

export interface RunOptions {
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    // Each line of either stream as it arrives, for a run somebody watches (an install, a sign-in).
    readonly onLine?: ((line: string) => void) | undefined;
    // Left open for a program that waits on it (a sign-in that would take a pasted code); closed otherwise.
    readonly keepStdin?: boolean | undefined;
    // Written to the program's stdin before it is closed.
    readonly input?: string | undefined;
}

// One side of this computer, as a harness sees it.
export interface PlaceHost {
    readonly key: string;
    // The platform programs run on there: a distro's is Linux, whatever this process runs on.
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    // The reader's home there, where a harness keeps its sign-in and this package keeps the adapters it fetched.
    readonly home: () => Promise<string>;
    readonly which: (bin: string) => Promise<string | undefined>;
    readonly exists: (path: string) => Promise<boolean>;
    readonly join: (...parts: string[]) => string;
    // A folder made with every folder above it, and a small text file written whole, for what this package keeps there.
    readonly mkdirs: (path: string) => Promise<void>;
    readonly write: (path: string, text: string) => Promise<void>;
    // A program started in `cwd` with the place's environment under `env`, its three streams piped.
    readonly spawn: (argv: readonly string[], cwd: string | undefined, env?: Readonly<Record<string, string>>) => Promise<ChildProcess>;
    readonly run: (argv: readonly string[], options?: RunOptions) => Promise<Ran>;
}

const OUTPUT_CAP = 256 * 1024;

/** Runs a started program to its end, keeping the tail of what it said. */
const collect = (child: ChildProcess, options: RunOptions = {}): Promise<Ran> =>
    new Promise((resolve) => {
        let stdout = ``;
        let stderr = ``;
        let carry = ``;
        const lines = (chunk: string): void => {
            if (options.onLine === undefined) {
                return;
            }
            const parts = (carry + chunk).split(/\r?\n|\r/);
            carry = parts.pop() ?? ``;
            for (const line of parts) {
                options.onLine(line);
            }
        };
        child.stdout?.setEncoding(`utf8`);
        child.stderr?.setEncoding(`utf8`);
        child.stdout?.on(`data`, (chunk: string) => {
            stdout = (stdout + chunk).slice(-OUTPUT_CAP);
            lines(chunk);
        });
        child.stderr?.on(`data`, (chunk: string) => {
            stderr = (stderr + chunk).slice(-OUTPUT_CAP);
            lines(chunk);
        });
        if (options.keepStdin !== true) {
            child.stdin?.end(options.input);
        }
        let stopped = false;
        const stop = (): void => {
            stopped = true;
            child.kill();
        };
        const timer = options.timeoutMs === undefined ? undefined : setTimeout(stop, options.timeoutMs);
        options.signal?.addEventListener(`abort`, stop, { once: true });
        let settled = false;
        const done = (code: number | null): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener(`abort`, stop);
            if (carry !== ``) {
                options.onLine?.(carry);
            }
            resolve({ code: stopped ? null : code, stdout, stderr });
        };
        // A program that is not there never ran: no code, and its error's words where stderr would be.
        child.on(`error`, (error) => {
            stderr ||= error.message;
            done(null);
        });
        child.on(`close`, done);
    });

// What a login shell prints its environment after, so whatever its profile says first is not read as a variable.
const ENV_MARK = `__INTENTIC_ENV__`;

/** The variables in what `env -0` printed after the mark; nothing when the mark never came. */
export const parseEnvironment = (said: string): Record<string, string> | undefined => {
    const at = said.lastIndexOf(ENV_MARK);
    if (at === -1) {
        return undefined;
    }
    const env: Record<string, string> = {};
    for (const entry of said.slice(at + ENV_MARK.length).split(`\0`)) {
        const eq = entry.indexOf(`=`);
        if (eq > 0) {
            env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
    }
    return Object.keys(env).length === 0 ? undefined : env;
};

// The reader's shell, asked as a terminal would start it (login and interactive, so both kinds of profile are read).
// One command every shell reads alike, fish included.
const SHELL_ENV_COMMAND = `printf ${ENV_MARK}; env -0`;
const SHELL_ENV_TIMEOUT_MS = 8_000;

const ownEnvironment = (): Record<string, string> =>
    Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));

const WINDOWS_EXTENSIONS = [`.exe`, `.cmd`, `.bat`, `.com`];

/** Where `bin` is on a PATH, as the platform would find it. */
export const findOnPath = (bin: string, path: string, platform: NodeJS.Platform, there: (file: string) => boolean = existsSync): string | undefined => {
    const names = platform === `win32` && !/\.[a-z]{2,4}$/i.test(bin) ? WINDOWS_EXTENSIONS.map((extension) => `${bin}${extension}`) : [bin];
    for (const dir of path.split(platform === `win32` ? `;` : `:`)) {
        if (dir === ``) {
            continue;
        }
        for (const name of names) {
            const candidate = join(dir, name);
            if (there(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
};

// Windows starts a `.cmd` or `.bat` only through its command interpreter.
const windowsArgv = (argv: readonly string[]): readonly string[] =>
    /\.(cmd|bat)$/i.test(argv[0] ?? ``) ? [process.env[`ComSpec`] ?? `cmd.exe`, `/d`, `/s`, `/c`, ...argv] : argv;

const PIPED = { stdio: [`pipe`, `pipe`, `pipe`], windowsHide: true } satisfies SpawnOptions;

export const nativePlace = (platform: NodeJS.Platform = process.platform): PlaceHost => {
    let asked: Promise<Record<string, string>> | undefined;
    // Windows has no profile a shell reads: a process there already has the reader's own variables.
    const environment = (): Promise<Record<string, string>> => {
        asked ??= (async () => {
            const own = ownEnvironment();
            const shell = own[`SHELL`];
            if (platform === `win32` || shell === undefined || shell === ``) {
                return own;
            }
            // In a session of its own: an interactive shell takes the terminal it finds, and one started from a terminal
            // (a dev run, a test) would take that one and leave this process stopped behind it.
            const ran = await collect(spawn(shell, [`-ilc`, SHELL_ENV_COMMAND], { ...PIPED, env: own, detached: true }), { timeoutMs: SHELL_ENV_TIMEOUT_MS });
            // A shell that would not answer (a profile that waits on a terminal) leaves a harness this process's own.
            return { ...own, ...parseEnvironment(ran.stdout) };
        })();
        return asked;
    };
    const start: PlaceHost[`spawn`] = async (argv, cwd, env) => {
        const [command = ``, ...args] = platform === `win32` ? windowsArgv(argv) : argv;
        return spawn(command, args, { ...PIPED, cwd, env: { ...(await environment()), ...env } });
    };
    return {
        key: `native`,
        platform,
        arch: process.arch,
        home: () => Promise.resolve(homedir()),
        which: async (bin) => {
            const env = await environment();
            return findOnPath(bin, env[`PATH`] ?? env[`Path`] ?? ``, platform);
        },
        exists: (path) => Promise.resolve(existsSync(path)),
        join: (...parts) => join(...parts),
        mkdirs: async (path) => {
            await mkdir(path, { recursive: true });
        },
        write: (path, text) => writeFile(path, text),
        spawn: start,
        run: async (argv, options = {}) => collect(await start(argv, options.cwd, options.env), options),
    };
};

// A program on one of Windows' drives, which a distro's PATH lists beside its own (`/mnt/c/…`). It is Windows' program:
// its Node would run a script on the Windows side of the share, and its npm is not a Linux program at all. A harness in
// a distro is run by the distro's own tools or not at all.
const WINDOWS_DRIVE = /^\/mnt\/[a-z]\//;

// A distro's own paths are POSIX whatever this process runs on.
const posixJoin = (...parts: string[]): string => parts.join(`/`).replaceAll(/\/{2,}/g, `/`);

const wslPlace = (distro: string): PlaceHost => {
    const through = (rest: readonly string[], cwd?: string): string[] => [`-d`, distro, ...(cwd === undefined ? [] : [`--cd`, cwd]), `--exec`, ...rest];
    let asked: Promise<Record<string, string>> | undefined;
    // The distro user's own shell, found by a plain sh, since `$SHELL` is the distro's to name.
    const environment = (): Promise<Record<string, string>> => {
        asked ??= (async () => {
            const child = spawn(`wsl.exe`, through([`sh`, `-c`, `exec "\${SHELL:-/bin/sh}" -ilc '${SHELL_ENV_COMMAND}'`]), PIPED);
            const ran = await collect(child, { timeoutMs: SHELL_ENV_TIMEOUT_MS * 2 });
            return parseEnvironment(ran.stdout) ?? {};
        })();
        return asked;
    };
    // Variables reach a distro's program as `env`'s own arguments: Windows' environment does not cross by itself.
    const start: PlaceHost[`spawn`] = async (argv, cwd, env) => {
        const pairs = Object.entries({ ...(await environment()), ...env }).map(([name, value]) => `${name}=${value}`);
        return spawn(`wsl.exe`, through(pairs.length === 0 ? argv : [`/usr/bin/env`, `-i`, ...pairs, ...argv], cwd), PIPED);
    };
    const said = async (argv: readonly string[]): Promise<string | undefined> => {
        const ran = await collect(await start(argv, undefined), { timeoutMs: 15_000 });
        return ran.code === 0 ? ran.stdout.trim() : undefined;
    };
    return {
        key: `wsl:${distro.toLowerCase()}`,
        platform: `linux`,
        arch: process.arch,
        home: async () => (await environment())[`HOME`] ?? (await said([`sh`, `-c`, `echo "$HOME"`])) ?? `/root`,
        which: async (bin) => {
            const found = await said([`sh`, `-c`, `command -v "$0"`, bin]);
            return found?.startsWith(`/`) === true && !WINDOWS_DRIVE.test(found) ? found : undefined;
        },
        exists: async (path) => (await said([`sh`, `-c`, `test -e "$0" && echo yes`, path])) === `yes`,
        join: posixJoin,
        mkdirs: async (path) => {
            await said([`mkdir`, `-p`, path]);
        },
        write: async (path, text) => {
            await collect(await start([`sh`, `-c`, `cat > "$0"`, path], undefined), { input: text, timeoutMs: 15_000 });
        },
        spawn: start,
        run: async (argv, options = {}) => collect(await start(argv, options.cwd, options.env), options),
    };
};

/** The host for a place, one per side of this computer for the process's life (its environment is asked once). */
export const placeHosts = (): ((place: Place) => PlaceHost) => {
    const hosts = new Map<string, PlaceHost>();
    return (place) => {
        const key = placeKey(place);
        let host = hosts.get(key);
        if (host === undefined) {
            host = place.kind === `native` ? nativePlace() : wslPlace(place.distro);
            hosts.set(key, host);
        }
        return host;
    };
};
