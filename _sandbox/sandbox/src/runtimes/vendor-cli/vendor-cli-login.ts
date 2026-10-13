import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { pollFor } from "@intentic/base/async";
import { plainText } from "@intentic/base/plain-text";
import { detachedStamp } from "../../seams/workload-stamp.js";
import { spawnAs } from "../../workload/workload-class.js";
import type { CliDeviceCode, VendorCli } from "./vendor-cli.js";

// A vendor CLI's device-code sign-in, driven through the CLI's own login command rather than re-implemented: the command
// prints a page and a code, then polls the vendor itself until the person approves, writes the tokens into the home it
// was pointed at, and exits 0. The daemon reads the page and code off its output for the connect card, waits for the
// exit, and hands the filled home over to become the account's (vendor-cli-door.ts). Nothing the CLI writes is read
// here: the home moves whole, tokens included, and only the CLI ever spends them.

// Both vendors' codes last half an hour (Kimi says 1800 s); the attempt holds no longer than that.
const LOGIN_WINDOW_MS = 30 * 60_000;
// How long the CLI may take to print its page.
const CODE_WAIT_MS = 30_000;

interface Attempt {
    readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
    // The attempt's own directory: the home the CLI signs into sits inside it, on the account store's filesystem, so
    // adopting it is a rename.
    readonly dir: string;
    readonly expiresAt: number;
    output: string;
}

// Handshake to attempt, in memory: a daemon restart drops a sign-in in flight, and its detached stamp ends the CLI.
const pending = new Map<string, Attempt>();

const plainOf = (output: string): string => plainText(output.replaceAll("\r\n", "\n"));

// The page and code as a device login prints them: the first https address, and the code it names, or failing that the
// `user_code` the address carries (both vendors put it there). Undefined until both are out.
export const deviceCodeOf = (output: string): CliDeviceCode | undefined => {
    const plain = plainOf(output);
    const url = plain.match(/https:\/\/\S+/u)?.[0];
    if (url === undefined) {
        return undefined;
    }
    const named = plain.match(/(?:enter code|code)[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})\b/iu)?.[1];
    const code = named ?? URL.parse(url)?.searchParams.get("user_code") ?? undefined;
    return code === undefined || code === "" ? undefined : { url, code };
};

// The last thing the CLI said, for a refusal: its final non-empty line ("Login failed: access denied", say).
export const lastWords = (output: string): string =>
    plainOf(output)
        .split("\n")
        .map((line) => line.trim())
        .findLast((line) => line !== "") ?? "";

// The daemon's environment for the CLI, minus a display: a login that finds one opens a browser on the sandbox's own
// desktop, where nobody is looking. The person's browser is wherever the card is.
const loginEnv = (cli: VendorCli, home: string, expiresAt: number): NodeJS.ProcessEnv => {
    const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...rest } = process.env;
    return { ...rest, ...cli.login.env(home), BROWSER: "true", ...detachedStamp("login-browser", expiresAt) };
};

const forget = async (handshake: string): Promise<void> => {
    const attempt = pending.get(handshake);
    pending.delete(handshake);
    if (attempt !== undefined) {
        attempt.child.kill("SIGTERM");
        await rm(attempt.dir, { recursive: true, force: true });
    }
};

export interface StartedCliLogin extends CliDeviceCode {
    readonly handshake: string;
    readonly expiresAt: number;
    // The home the CLI signed into once it exits 0; rejects with the CLI's own last words when it does not, or when the
    // window closes first. The caller adopts the home and then calls `releaseCliLogin`.
    readonly signedIn: Promise<string>;
}

export const cliLoginOpen = (handshake: string): boolean => {
    const attempt = pending.get(handshake);
    return attempt !== undefined && attempt.expiresAt > Date.now();
};

// Starts the CLI's login into a fresh home under `stagingRoot` and answers once it has printed its page and code.
export const startCliLogin = async (cli: VendorCli, binary: string, stagingRoot: string): Promise<StartedCliLogin> => {
    const handshake = randomUUID();
    const dir = join(stagingRoot, ".signing-in", handshake);
    const home = join(dir, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const expiresAt = Date.now() + LOGIN_WINDOW_MS;
    const [command, ...args] = cli.login.argv(binary);
    // Detached with its deadline stamped, so the reaper ends it even if this daemon is gone before anyone answers.
    const child = spawnAs({ class: "agentRuntime", spawnDepth: 0 }, command ?? binary, args, {
        cwd: dir,
        env: loginEnv(cli, home, expiresAt),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const attempt: Attempt = { child, dir, expiresAt, output: "" };
    pending.set(handshake, attempt);
    const heard = (chunk: Buffer): void => {
        attempt.output += chunk.toString("utf8");
    };
    child.stdout.on("data", heard);
    child.stderr.on("data", heard);
    let ended = false;
    const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
    }).then((code) => {
        ended = true;
        return code;
    });
    const timer = setTimeout(() => void forget(handshake), Math.max(0, expiresAt - Date.now()));
    timer.unref();
    const signedIn = exited.then((code) => {
        clearTimeout(timer);
        if (code === 0 && pending.has(handshake)) {
            return home;
        }
        const said = lastWords(attempt.output);
        throw new Error(
            pending.has(handshake)
                ? said === ""
                    ? `${cli.name} did not finish signing in.`
                    : `${cli.name} did not finish signing in: ${said}`
                : "That sign-in has expired or was cancelled: start it again.",
        );
    });
    // Read before the code each probe, so a CLI found gone had already printed all it ever will.
    const offered = await pollFor(
        async () => {
            const over = ended;
            const code = cli.login.deviceCode(attempt.output);
            if (code === undefined && over) {
                const said = lastWords(attempt.output);
                await forget(handshake);
                throw new Error(
                    said === ""
                        ? `${cli.name} ended before it offered a sign-in page.`
                        : `${cli.name} ended before it offered a sign-in page: ${said}`,
                );
            }
            return code;
        },
        { intervalMs: 100, until: Date.now() + CODE_WAIT_MS },
    );
    if (offered.kind !== "found") {
        await forget(handshake);
        throw new Error(`${cli.name} did not offer a sign-in page in time.`);
    }
    // allow(silent-catch): the promise is handed on whole and its owner reads the failure; this only stops one that ends
    // while the page is still awaited from surfacing as unhandled.
    signedIn.catch(() => undefined);
    return { ...offered.value, handshake, expiresAt, signedIn };
};

// Ends an attempt and removes its directory (the home is gone from it once adopted). Unknown ids are a no-op: the attempt
// already expired or already landed, both states the caller wanted.
export const releaseCliLogin = (handshake: string): Promise<void> => forget(handshake);
