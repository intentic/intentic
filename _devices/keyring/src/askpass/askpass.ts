import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";

// What an askpass prompt asks for, read from the words ssh, sudo and git print, and which entry's `askpass` matchers
// (protocol.ts AskpassMatcherSchema) answer it. Pure: the prompt is the program's own text, passed on intentic-askpass's
// command line, so it is read as data and never trusted for more than picking an entry; the person's yes is what
// releases the value.

export interface AskpassQuestion {
    // A user name prompt is answered with the entry's `username`, which is not a secret; anything else with its value.
    readonly wants: "secret" | "username";
    // The matchers that answer it, most specific first.
    readonly matchers: readonly string[];
    // The prompt in a line, for the person answering.
    readonly prompt: string;
}

const SSH_PASSWORD = /^(?<user>[^\s@']+)@(?<host>[^\s']+)'s password:\s*$/u;
const SSH_KEYBOARD = /^\((?<user>[^\s@()]+)@(?<host>[^\s()]+)\) Password:\s*$/iu;
const SSH_KEY = /^Enter passphrase for key '(?<path>[^']+)':\s*$/u;
const SUDO = /^\[sudo\] password for (?<user>[^\s:]+):\s*$/u;
const GIT_PASSWORD = /^Password for '(?<url>[^']+)':\s*$/u;
const GIT_USERNAME = /^Username for '(?<url>[^']+)':\s*$/u;

// `https://user@host:port/path` as `https://host:port`: git names the user in the prompt when it knows one, and an
// entry names the site.
const gitSite = (url: string): string | undefined => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        // allow(silent-catch): a prompt naming no URL is then read as plain prompt text, which is the fallback below
        return undefined;
    }
    return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
};

const lineOf = (prompt: string): string => prompt.replace(/\s+/gu, " ").trim();

export const parseAskpassPrompt = (prompt: string): AskpassQuestion => {
    const text = prompt.trim();
    const shown = lineOf(prompt);
    const ssh = SSH_PASSWORD.exec(text) ?? SSH_KEYBOARD.exec(text);
    if (ssh?.groups?.["user"] !== undefined && ssh.groups["host"] !== undefined) {
        return { wants: "secret", matchers: [`ssh:${ssh.groups["user"]}@${ssh.groups["host"].toLowerCase()}`], prompt: shown };
    }
    const key = SSH_KEY.exec(text)?.groups?.["path"];
    if (key !== undefined) {
        return { wants: "secret", matchers: [`ssh-key:${key}`], prompt: shown };
    }
    const sudo = SUDO.exec(text)?.groups?.["user"];
    if (sudo !== undefined) {
        return { wants: "secret", matchers: [`sudo:${sudo}`, "sudo"], prompt: shown };
    }
    for (const [pattern, wants] of [
        [GIT_PASSWORD, "secret"],
        [GIT_USERNAME, "username"],
    ] as const) {
        const url = pattern.exec(text)?.groups?.["url"];
        const site = url === undefined ? undefined : gitSite(url);
        if (site !== undefined) {
            return { wants, matchers: [`git:${site}`], prompt: shown };
        }
    }
    return { wants: "secret", matchers: [`prompt:${shown}`], prompt: shown };
};

// The form a matcher is compared in: hosts and git sites without case, prompt text with its spacing and case folded,
// a key path as written.
export const normalMatcher = (matcher: string): string => {
    const colon = matcher.indexOf(":");
    const kind = colon === -1 ? matcher : matcher.slice(0, colon);
    const rest = colon === -1 ? "" : matcher.slice(colon + 1);
    switch (kind) {
        case "ssh":
            return `ssh:${rest.replace(/@(.*)$/u, (_match, host: string) => `@${host.toLowerCase()}`)}`;
        case "git":
            return `git:${gitSite(rest) ?? rest.toLowerCase()}`;
        case "prompt":
            return `prompt:${lineOf(rest).replace(/[:?]\s*$/u, "").toLowerCase()}`;
        default:
            return matcher;
    }
};

// Which of `matchers` (an entry's) answers `question`, the most specific match first, or undefined for none.
export const askpassMatch = (question: AskpassQuestion, matchers: readonly string[]): string | undefined => {
    const own = new Map(matchers.map((matcher) => [normalMatcher(matcher), matcher]));
    for (const wanted of question.matchers) {
        const found = own.get(normalMatcher(wanted));
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
};

// Where an askpass prompt is, as the Passwords app speaks of it (keyring-origins.ts): what a value typed once into the
// keyring's box for it is saved under. A git prompt that names its user (`https://user@host`) gives the account.
export interface AskpassPlace {
    readonly origin: KeyringOrigin;
    readonly username?: string | undefined;
}

const gitUser = (prompt: string): string | undefined => {
    const url = /'(?<url>[^']+)'/u.exec(prompt)?.groups?.["url"];
    try {
        const user = url === undefined ? "" : decodeURIComponent(new URL(url).username);
        return user === "" ? undefined : user;
    } catch {
        // allow(silent-catch): a prompt naming no URL names no account, which the box then asks for
        return undefined;
    }
};

export const askpassPlace = (question: AskpassQuestion, prompt: string): AskpassPlace => {
    const matcher = question.matchers[0] ?? `prompt:${question.prompt}`;
    const colon = matcher.indexOf(":");
    const kind = colon === -1 ? matcher : matcher.slice(0, colon);
    const rest = colon === -1 ? "" : matcher.slice(colon + 1);
    switch (kind) {
        case "ssh":
            return { origin: { kind: "ssh", target: rest }, username: rest.split("@")[0] };
        case "ssh-key":
            return { origin: { kind: "ssh-key", path: rest } };
        case "sudo":
            return rest === "" ? { origin: { kind: "sudo" } } : { origin: { kind: "sudo", user: rest }, username: rest };
        case "git":
            return { origin: { kind: "git", url: rest }, username: gitUser(prompt) };
        default:
            return { origin: { kind: "prompt", text: (question.prompt === "" ? "Password:" : question.prompt).slice(0, 300) } };
    }
};
