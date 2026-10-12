import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { pollFor, within } from "@intentic/base/async";
import { undefinedIfMissing } from "@intentic/base/errors";
import { plainText } from "@intentic/base/plain-text";
import { parse as parseToml } from "smol-toml";
import { detachedStamp } from "../../../seams/workload-stamp.js";
import { runCheck } from "../../../workload/run-check.js";
import { spawnAs } from "../../../workload/workload-class.js";

// Devin's sign-in, driven through its own CLI rather than re-implemented, in either of the two ways the CLI offers:
//
// browser  `devin auth login` sends the browser to Devin's page, which redirects to http://127.0.0.1:<port>/callback where
//          the CLI listens. The person's browser is not on this machine, so that landing is caught on their own machine
//          (loopback-bridge.ts) or pasted from its address bar, and replayed here against the CLI's own listener, which
//          is exactly the request a browser beside the CLI would have made. The CLI then redeems the code itself.
// manual   `devin auth login --force-manual-token-flow` sends the browser to a page that shows a code, and waits for it
//          to be typed. For a sandbox where nothing of the owner's watches loopback.
//
// Either way the CLI writes the account's key to its credentials.toml in a throwaway data directory; the key is moved
// into the account store and the directory goes. The CLI talks to its terminal (its menu, its code prompt), so it runs
// under `script`, whose private terminal reads this process's pipe; the terminal's questions about itself (where the
// cursor is, what it is) are answered as any terminal would, or the menu never draws.

// The page's code lasts five minutes; the attempt holds longer, for a person who has to create the account first.
const LOGIN_WINDOW_MS = 15 * 60_000;
// How long the CLI may take to print its page, and to redeem a pasted code.
const URL_WAIT_MS = 30_000;
const REDEEM_WAIT_MS = 60_000;

export type DevinLoginMode = "browser" | "manual";

// Where a browser-mode attempt's landing goes: the CLI's own listener, and the state that marks this attempt's landing.
export interface DevinLanding {
    readonly host: "localhost" | "127.0.0.1";
    readonly port: number;
    readonly path: string;
    readonly state: string;
}

interface Attempt {
    readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
    readonly dir: string;
    readonly binary: string;
    readonly mode: DevinLoginMode;
    readonly expiresAt: number;
    readonly exited: Promise<number | null>;
    output: string;
    landing?: DevinLanding;
    // Set once a code or a landing is being redeemed, so a paste and a caught landing never redeem one sign-in twice.
    finishing: boolean;
}

// Handshake id to attempt; in memory, so a daemon restart drops any sign-in in flight (and the CLI reads end-of-file).
const pending = new Map<string, Attempt>();

// The terminal's text without its escapes: the CLI wraps its link in an OSC 8 hyperlink, and the terminal ends lines in
// a carriage return.
const plainOf = (output: string): string => plainText(output.replaceAll("\r\n", "\n"));

// The page the CLI asks to be opened, read off its output; undefined until it has printed one.
export const signInUrlOf = (output: string): string | undefined => plainOf(output).match(/https:\/\/\S+/u)?.[0];

// Where the page sends the browser back to, read off the URL the CLI opened: its loopback `redirect_uri` and its state.
// Undefined for a page that does not come back to loopback (the manual flow's).
export const landingOf = (url: string): DevinLanding | undefined => {
    const page = URL.parse(url);
    const redirect = page === null ? null : URL.parse(page.searchParams.get("redirect_uri") ?? "");
    if (page === null || redirect === null) {
        return undefined;
    }
    const port = Number(redirect.port);
    const state = page.searchParams.get("state") ?? "";
    const host = redirect.hostname;
    if (redirect.protocol !== "http:" || (host !== "localhost" && host !== "127.0.0.1") || !Number.isInteger(port) || port < 1 || state === "") {
        return undefined;
    }
    return { host, port, path: redirect.pathname, state };
};

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

// What the CLI runs to open its page: a script that only writes the address down, since the browser that opens it is the
// person's, elsewhere. The CLI takes a zero exit as a browser opened and goes on to wait for the landing.
const OPENER = "open-browser";
const openedFile = (dir: string): string => join(dir, "browser-url");
const writeOpener = async (dir: string): Promise<string> => {
    const path = join(dir, OPENER);
    await writeFile(path, `#!/bin/sh\nprintf '%s' "$1" > ${quoted(openedFile(dir))}\n`, { mode: 0o700 });
    return path;
};

// The two questions the CLI's terminal library asks before it draws (where the cursor is, what the terminal is),
// answered as a plain VT220 at the top-left corner would.
const CURSOR_QUERY = "\u001b[6n";
const DEVICE_QUERY = "\u001b[c";
const answerTerminal = (chunk: string, stdin: Writable): void => {
    if (chunk.includes(CURSOR_QUERY)) {
        stdin.write("\u001b[1;1R");
    }
    if (chunk.includes(DEVICE_QUERY)) {
        stdin.write("\u001b[?62;22c");
    }
};

// The CLI's menu, answered with its first entry, "Log in with browser".
const LOGIN_MENU = "How would you like to log in?";

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
    // Browser mode only: where the page comes back to.
    readonly landing?: DevinLanding;
}

// Whether a sign-in is still waiting for its code or landing.
export const devinLoginOpen = (handshake: string): boolean => {
    const attempt = pending.get(handshake);
    return attempt !== undefined && attempt.expiresAt > Date.now();
};

// Starts the CLI's sign-in and answers with its page once it has one; the CLI then waits for the code or the landing.
export const startDevinLogin = async (binary: string, mode: DevinLoginMode): Promise<StartedDevinLogin> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-devin-login-"));
    const handshake = randomUUID();
    const expiresAt = Date.now() + LOGIN_WINDOW_MS;
    const opener = await writeOpener(dir);
    const command = mode === "manual" ? "auth login --force-manual-token-flow" : "auth login";
    // Detached with its deadline stamped, so the reaper ends it even if this daemon is gone before anyone answers.
    // Sized before the CLI starts: `script`'s terminal is 0×0 when its own input is a pipe, and the CLI draws its menu
    // into the size it is given, so at 0×0 nothing is drawn and the menu is never there to answer.
    const child = spawnAs(
        { class: "agentRuntime", spawnDepth: 0 },
        "script",
        ["-qfec", `stty cols 120 rows 40; exec ${quoted(binary)} ${command}`, "/dev/null"],
        {
            cwd: dir,
            env: { ...cliEnv(dir), BROWSER: opener, ...detachedStamp("login-browser", expiresAt) },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        },
    );
    const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
    });
    const attempt: Attempt = { child, dir, binary, mode, expiresAt, exited, output: "", finishing: false };
    let chose = false;
    const heard = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        attempt.output += text;
        answerTerminal(text, child.stdin);
        if (mode === "browser" && !chose && plainOf(attempt.output).includes(LOGIN_MENU)) {
            chose = true;
            child.stdin.write("\r");
        }
    };
    child.stdout.on("data", heard);
    child.stderr.on("data", heard);
    pending.set(handshake, attempt);
    const timer = setTimeout(() => void forget(handshake), LOGIN_WINDOW_MS);
    timer.unref();
    void exited.then(() => clearTimeout(timer));

    // The manual page is printed; the browser page is handed to the opener, and printed too by some versions.
    const pageOf = async (): Promise<string | undefined> => {
        if (mode === "manual") {
            return signInUrlOf(attempt.output);
        }
        const opened = ((await readFile(openedFile(dir), "utf8").catch(undefinedIfMissing)) ?? "").trim();
        return opened !== "" ? opened : signInUrlOf(attempt.output);
    };
    // Read before the page each probe, so a CLI found gone had already printed all it ever will.
    let ended = false;
    void exited.then(() => {
        ended = true;
    });
    const offered = await pollFor(
        async () => {
            const over = ended;
            const url = await pageOf();
            if (url === undefined && over) {
                await forget(handshake);
                const said = lastWords(attempt.output);
                throw new Error(
                    said === "" ? "Devin's CLI ended before it offered a sign-in page." : `Devin's CLI ended before it offered a sign-in page: ${said}`,
                );
            }
            return url;
        },
        { intervalMs: 100, until: Date.now() + URL_WAIT_MS },
    );
    if (offered.kind !== "found") {
        await forget(handshake);
        throw new Error("Devin's CLI did not offer a sign-in page in time.");
    }
    const url = offered.value;
    if (mode === "manual") {
        return { url, handshake, expiresAt };
    }
    const landing = landingOf(url);
    if (landing === undefined) {
        await forget(handshake);
        throw new Error("Devin's CLI offered a sign-in page that does not come back to it.");
    }
    attempt.landing = landing;
    return { url, handshake, expiresAt, landing };
};

export interface RedeemedDevinLogin {
    readonly apiKey: string;
    readonly email?: string;
    readonly plan?: string;
}

// Where a caught or pasted landing is replayed: the CLI's own listener, at the attempt's own port and path, never a host
// the address names, so a paste cannot point this daemon anywhere else. Throws, touching nothing, for an address that
// is not this attempt's landing: the CLI is still waiting, and the person can paste again.
const replayTarget = (landing: DevinLanding, address: string): string => {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        throw new Error("Paste the whole address the sign-in page sent your browser to.");
    }
    if (url.searchParams.get("code") === null) {
        throw new Error("Paste the whole address the sign-in page sent your browser to.");
    }
    // Checked against the attempt's own state, never a value the caller sent: a mismatch is another sign-in's landing.
    if (url.searchParams.get("state") !== landing.state) {
        throw new Error("That belongs to a different sign-in: use the one this attempt opened.");
    }
    return `http://127.0.0.1:${landing.port}${landing.path}${url.search}`;
};

// Hands the CLI what the person brought back (the manual page's code, or the browser page's landing), waits for it to
// redeem it, and takes the key it wrote. Once the CLI has heard it the attempt is gone whatever happened: a refused code
// or landing means starting again, as either is single-use.
export const finishDevinLogin = async (handshake: string, grant: string): Promise<RedeemedDevinLogin> => {
    const attempt = pending.get(handshake);
    if (attempt === undefined || attempt.expiresAt <= Date.now()) {
        await forget(handshake);
        throw new Error("That sign-in has expired or was never started here: start it again.");
    }
    if (attempt.finishing) {
        throw new Error("This sign-in is already finishing.");
    }
    const brought = grant.trim();
    if (brought === "") {
        throw new Error(
            attempt.mode === "manual" ? "Paste the code the sign-in page showed." : "Paste the whole address the sign-in page sent your browser to.",
        );
    }
    const replay = attempt.landing === undefined ? undefined : replayTarget(attempt.landing, brought);
    attempt.finishing = true;
    try {
        if (replay === undefined) {
            attempt.child.stdin.write(`${brought}\r`);
        } else {
            const response = await fetch(replay, { signal: AbortSignal.timeout(REDEEM_WAIT_MS) });
            await response.body?.cancel();
        }
        const exit = await within(attempt.exited, REDEEM_WAIT_MS, "slow" as const);
        if (exit === "slow") {
            throw new Error("Devin's CLI did not finish signing in in time. Start the sign-in again.");
        }
        const toml = (await readFile(join(attempt.dir, "data", "devin", "credentials.toml"), "utf8").catch(undefinedIfMissing)) ?? "";
        const apiKey = toml === "" ? undefined : keyOf(toml);
        if (exit !== 0 || apiKey === undefined) {
            const said = lastWords(attempt.output);
            throw new Error(said === "" ? "Devin did not accept that sign-in. Start it again." : `Devin did not accept that sign-in: ${said}`);
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
