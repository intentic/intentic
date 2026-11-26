import { spawn } from "node:child_process";
import type { ImapCard } from "./card.js";
import { curlLogin, type MailCredential, withCurlLogin } from "./send.js";

// `imap curl`: one IMAP request to the card's own server with the card's login, run by the extension's backend, which
// holds the login, and answered with what curl printed. Only the options that shape an IMAP request are taken, and
// only a URL on the card's own host and port: an option that names another server, a file, a proxy, another login or
// a protocol trace would let the request carry the login somewhere else or print it, so it is refused before curl
// runs. Writing the answer to a file (`-o`) is the CLI's, in the agent's own checkout.

// Options that take no value.
const FLAGS = new Set(["-s", "--silent", "-S", "--show-error", "-sS", "-Ss", "-f", "--fail", "-l", "--list-only"]);
// Options followed by one value; the request itself and the two time limits.
const VALUED = new Set(["-X", "--request", "-m", "--max-time", "--connect-timeout"]);

// How long one request may take, below the backend's own ten-minute deadline for a tool call.
const MAX_SECONDS = 540;
// What one answer may carry back: a whole message with its attachments, base64 on the way.
const OUTPUT_MAX = 48 * 1024 * 1024;
const ERROR_MAX = 4096;

const defaultPort = (protocol: string): string => (protocol === "imap:" ? "143" : "993");

const checkedUrl = (card: ImapCard, raw: string): string => {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`not a URL: ${raw}`);
    }
    if (url.protocol !== "imaps:" && url.protocol !== "imap:") {
        throw new Error("`imap curl` reaches only the mailbox: use an imaps:// URL");
    }
    if (url.username !== "" || url.password !== "") {
        throw new Error("the login is supplied for you: leave it out of the URL");
    }
    const port = url.port === "" ? defaultPort(url.protocol) : url.port;
    if (url.hostname.toLowerCase() !== card.host.toLowerCase() || port !== card.port) {
        throw new Error(`\`imap curl\` reaches only this card's server, ${card.host}:${card.port}`);
    }
    return raw;
};

const seconds = (value: string): string => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        throw new Error(`not a number of seconds: ${value}`);
    }
    return String(Math.min(number, MAX_SECONDS));
};

// One word of the request as curl reads it: a URL, a flag, or an option with its value (`-X CMD`, `-XCMD`, `--x=v`).
type Word = { readonly kind: "url"; readonly url: string } | { readonly kind: "option"; readonly name: string; readonly value?: string };

// A word and where the next one starts.
interface Read {
    readonly word: Word;
    readonly next: number;
}

const wordAt = (args: readonly string[], index: number): Read => {
    const raw = args[index] ?? "";
    const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const name = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);
    if (!raw.startsWith("-")) {
        return { word: { kind: "url", url: raw }, next: index + 1 };
    }
    if (name === "--url") {
        return { word: { kind: "url", url: inline ?? args[index + 1] ?? "" }, next: inline === undefined ? index + 2 : index + 1 };
    }
    if (name.startsWith("-X") && name.length > 2) {
        return { word: { kind: "option", name: "-X", value: name.slice(2) }, next: index + 1 };
    }
    if (VALUED.has(name) && inline === undefined) {
        const value = args[index + 1];
        if (value === undefined) {
            throw new Error(`${name} takes a value`);
        }
        return { word: { kind: "option", name, value }, next: index + 2 };
    }
    return { word: inline === undefined ? { kind: "option", name } : { kind: "option", name, value: inline }, next: index + 1 };
};

// An option as curl gets it: a time limit capped below the backend's deadline, anything else outside the set refused.
const optionArgs = (name: string, value: string | undefined): string[] => {
    if (FLAGS.has(name) && value === undefined) {
        return [name];
    }
    if (VALUED.has(name) && value !== undefined) {
        return [name, name === "-X" || name === "--request" ? value : seconds(value)];
    }
    throw new Error(`\`imap curl\` does not take ${name}: it takes the URL, -X/--request with an IMAP command, -s, -S, -f, -l, -m and --connect-timeout`);
};

/** curl's arguments for one request, from what the agent typed after `imap curl`; throws on anything else. */
export const requestArgs = (card: ImapCard, args: readonly string[]): string[] => {
    const out: string[] = [];
    const urls: string[] = [];
    for (let index = 0; index < args.length; ) {
        const { word, next } = wordAt(args, index);
        index = next;
        if (word.kind === "url") {
            urls.push(checkedUrl(card, word.url));
        } else {
            out.push(...optionArgs(word.name, word.value));
        }
    }
    const [url] = urls;
    if (url === undefined || urls.length > 1) {
        throw new Error("`imap curl` takes exactly one mailbox URL, e.g. --url \"imaps://$IMAP_HOST:$IMAP_PORT/INBOX\"");
    }
    const timed = out.includes("-m") || out.includes("--max-time");
    return ["--ssl-reqd", ...(timed ? [] : ["--max-time", String(MAX_SECONDS)]), ...out, "--url", url];
};

export interface RequestAnswer {
    readonly exitCode: number;
    readonly stdout: Buffer;
    readonly stderr: string;
}

export type Curl = (args: readonly string[]) => Promise<RequestAnswer>;

const runCurl: Curl = (args) =>
    new Promise<RequestAnswer>((resolve, reject) => {
        const child = spawn("curl", [...args], { stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        let size = 0;
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > OUTPUT_MAX) {
                child.kill();
                return;
            }
            chunks.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr = `${stderr}${chunk.toString()}`.slice(0, ERROR_MAX);
        });
        child.on("error", reject);
        child.on("close", (code) =>
            resolve({ exitCode: size > OUTPUT_MAX ? 63 : (code ?? 1), stdout: Buffer.concat(chunks), stderr: size > OUTPUT_MAX ? "the answer was larger than 48 MiB" : stderr }),
        );
    });

/** One request with the card's login in a 0600 config file, never on curl's command line. */
export const runRequest = (card: ImapCard, credential: MailCredential, args: readonly string[], curl: Curl = runCurl): Promise<RequestAnswer> => {
    const request = requestArgs(card, args);
    return withCurlLogin(curlLogin(card.username, credential), (config) => curl(["--config", config, ...request]));
};
