import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { plainText } from "@intentic/base/plain-text";
import { parse as parseToml } from "smol-toml";
import { detachedStamp } from "../../../seams/workload-stamp.js";
import { runCheck } from "../../../workload/run-check.js";
import { spawnAs } from "../../../workload/workload-class.js";

// Devin's sign-in, driven through its own CLI rather than re-implemented: `devin auth login --force-manual-token-flow`
// prints a page to open and waits for the code that page shows, then writes the account's key to its credentials.toml.
// The daemon runs it in a throwaway data directory (the key is moved into the account store, then the directory goes),
// and hands the page to the card as a paste flow. The CLI reads the code from its terminal, not from a pipe, so it runs
// under `script`, which gives it a private one whose input is this process's pipe.

// The page's code lasts five minutes; the attempt holds longer, for a person who has to create the account first.
const LOGIN_WINDOW_MS = 15 * 60_000;
// How long the CLI may take to print its page, and to redeem a pasted code.
const URL_WAIT_MS = 30_000;
const REDEEM_WAIT_MS = 60_000;

interface Attempt {
    readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
    readonly dir: string;
    readonly binary: string;
    readonly expiresAt: number;
    readonly exited: Promise<number | null>;
    output: string;
}

// Handshake id to attempt; in memory, so a daemon restart drops any sign-in in flight (and the CLI reads end-of-file).
const pending = new Map<string, Attempt>();

// The terminal's text without its escapes: the CLI wraps its link in an OSC 8 hyperlink, and the terminal ends lines in
// a carriage return.
const plainOf = (output: string): string => plainText(output.replaceAll("\r\n", "\n"));

// The page the CLI asks to be opened, read off its output; undefined until it has printed one.
export const signInUrlOf = (output: string): string | undefined => plainOf(output).match(/https:\/\/\S+/u)?.[0];

// The key `devin auth login` wrote, from its credentials.toml; undefined when the file holds none.
export const keyOf = (toml: string): string | undefined => {
    const parsed = parseToml(toml) as Record<string, unknown>;
    const key = parsed["windsurf_api_key"];
    return typeof key === "string" && key !== "" ? key : undefined;
};

// Who the CLI says is signed in, from `devin auth status`'s own words; each fact absent when it said nothing.
export const statusFacts = (output: string): { readonly email?: string; readonly plan?: string } => {
    const plain = plainOf(output);
    const email = plain.match(/^\s*Email:\s*(\S+@\S+)\s*$/mu)?.[1];
    const plan = plain.match(/^\s*Plan:\s*(.+?)\s*$/mu)?.[1];
    return { ...(email !== undefined ? { email } : {}), ...(plan !== undefined ? { plan } : {}) };
};

// The last thing the CLI said, for a refusal: its final non-empty line ("Error: Invalid code", say).
const lastWords = (output: string): string =>
    plainOf(output)
        .split("\n")
        .map((line) => line.trim())
        .findLast((line) => line !== "") ?? "";

// Single-quoted for the shell `script` hands its command to; the binary path is the engine store's or the image's.
const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

// The CLI's own data and config under one throwaway directory, so its sign-in never touches the CLI's shared files.
const cliEnv = (dir: string): NodeJS.ProcessEnv => ({
    ...process.env,
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CONFIG_HOME: join(dir, "config"),
    TERM: "dumb",
    NO_COLOR: "1",
});

// Ends the attempt and removes its directory, which holds the key once the CLI has redeemed a code: awaited wherever the
// caller goes on, so no copy of a key outlives the sign-in that wrote it.
const forget = async (handshake: string): Promise<void> => {
    const attempt = pending.get(handshake);
    pending.delete(handshake);
    if (attempt !== undefined) {
        attempt.child.kill("SIGTERM");
        await rm(attempt.dir, { recursive: true, force: true });
    }
};

export interface StartedDevinLogin {
    readonly url: string;
    readonly handshake: string;
    readonly expiresAt: number;
}

// Starts the CLI's sign-in and answers with its page once printed; the CLI then waits on its terminal for the code.
export const startDevinLogin = async (binary: string): Promise<StartedDevinLogin> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-devin-login-"));
    const handshake = randomUUID();
    const expiresAt = Date.now() + LOGIN_WINDOW_MS;
    // Detached with its deadline stamped, so the reaper ends it even if this daemon is gone before anyone answers.
    const child = spawnAs(
        { class: "agentRuntime", spawnDepth: 0 },
        "script",
        ["-qfec", `${quoted(binary)} auth login --force-manual-token-flow`, "/dev/null"],
        {
            cwd: dir,
            env: { ...cliEnv(dir), ...detachedStamp("login-browser", expiresAt) },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        },
    );
    const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
    });
    const attempt: Attempt = { child, dir, binary, expiresAt, exited, output: "" };
    const heard = (chunk: Buffer): void => {
        attempt.output += chunk.toString("utf8");
    };
    child.stdout.on("data", heard);
    child.stderr.on("data", heard);
    pending.set(handshake, attempt);
    const timer = setTimeout(() => void forget(handshake), LOGIN_WINDOW_MS);
    timer.unref();
    void exited.then(() => clearTimeout(timer));

    const deadline = Date.now() + URL_WAIT_MS;
    while (Date.now() < deadline) {
        const url = signInUrlOf(attempt.output);
        if (url !== undefined) {
            return { url, handshake, expiresAt };
        }
        const ended = await Promise.race([exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))]);
        if (ended && signInUrlOf(attempt.output) === undefined) {
            await forget(handshake);
            const said = lastWords(attempt.output);
            throw new Error(
                said === "" ? "Devin's CLI ended before it offered a sign-in page." : `Devin's CLI ended before it offered a sign-in page: ${said}`,
            );
        }
    }
    await forget(handshake);
    throw new Error("Devin's CLI did not offer a sign-in page in time.");
};

export interface RedeemedDevinLogin {
    readonly apiKey: string;
    readonly email?: string;
    readonly plan?: string;
}

// Types the page's code into the CLI's terminal, waits for it to redeem it, and takes the key it wrote. The attempt is
// gone afterwards whatever happened: a refused code means starting again, as the page's own code is single-use.
export const redeemDevinLogin = async (handshake: string, code: string): Promise<RedeemedDevinLogin> => {
    const attempt = pending.get(handshake);
    if (attempt === undefined || attempt.expiresAt <= Date.now()) {
        await forget(handshake);
        throw new Error("That sign-in has expired or was never started here: start it again.");
    }
    try {
        attempt.child.stdin.write(`${code.trim()}\r`);
        const exit = await Promise.race([attempt.exited, new Promise<"slow">((resolve) => setTimeout(() => resolve("slow"), REDEEM_WAIT_MS))]);
        if (exit === "slow") {
            throw new Error("Devin's CLI did not finish signing in in time. Start the sign-in again.");
        }
        const toml = await readFile(join(attempt.dir, "data", "devin", "credentials.toml"), "utf8").catch(() => "");
        const apiKey = toml === "" ? undefined : keyOf(toml);
        if (exit !== 0 || apiKey === undefined) {
            const said = lastWords(attempt.output);
            throw new Error(said === "" ? "Devin did not accept that code. Start the sign-in again." : `Devin did not accept that code: ${said}`);
        }
        // Who it is, best effort: a status the CLI cannot answer leaves the row nameless, which renaming fixes.
        const status = await runCheck({
            argv: [attempt.binary, "auth", "status"],
            cwd: attempt.dir,
            env: cliEnv(attempt.dir),
            timeoutMs: 30_000,
            workload: { class: "agentRuntime", spawnDepth: 0 },
            kind: "probe",
            captureBytes: 64 * 1024,
        });
        return { apiKey, ...(status.exitCode === 0 ? statusFacts(status.stdout) : {}) };
    } finally {
        await forget(handshake);
    }
};

// Unknown ids are a no-op: the attempt already expired or already landed, both states the caller wanted.
export const cancelDevinLogin = (handshake: string): void => {
    void forget(handshake);
};
