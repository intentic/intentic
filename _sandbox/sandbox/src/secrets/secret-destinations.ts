import { normalizeHost } from "@intentic/sandbox-contract";

// Where one use of a secret would send it, read from the reference-form text before anything runs, for the host limit
// (host-guard-gate.ts). Heuristic by nature, so it reads the other way round from a classifier: it proves nothing, and
// every doubt is an answer of its own. `certain` is only ever said of one simple command run by a program whose
// destination sits in its arguments (curl, wget, git), with every host it names readable and no shell feature that could
// change them at run time. That is "every host the text names is these", never "this is safe"; the owner's list decides
// the rest. The machine is not read at all: a .curlrc, a git config or /etc/hosts can still point a named host elsewhere.

export type Destination =
    // Every host the use names; never empty.
    | { readonly certain: true; readonly hosts: readonly string[] }
    // Why it cannot be read, as a clause that finishes "…because ": the card and the refusal both say it.
    | { readonly certain: false; readonly why: string };

// Why a part of the command cannot be read; every reader below answers either its finding or one of these.
interface Unreadable {
    readonly why: string;
}

const unreadable = (why: string): Destination => ({ certain: false, why });

// A reference stands in as a character no host, flag or operator contains, so a secret spelled into a host or a program
// name fails every test below instead of passing as whatever its value happens to be.
const REFERENCE = /\{\{secret:[A-Za-z0-9_./-]+\}\}/g;
const STAND_IN = "\u0001";

// One shell word with its quoting taken off; `dynamic` when a `$` expansion inside double quotes fills part of it, whose
// value exists only when the command runs.
interface Word {
    readonly text: string;
    readonly dynamic: boolean;
}

// Characters that end a simple command or send its input or output somewhere else, outside quotes.
const OPERATORS: ReadonlyMap<string, string> = new Map([
    ["|", "it pipes into another command"],
    ["&", "it runs more than one command"],
    [";", "it runs more than one command"],
    ["\n", "it runs more than one command"],
    ["<", "it redirects input or output"],
    [">", "it redirects input or output"],
    ["(", "it opens a subshell"],
    [")", "it opens a subshell"],
    ["`", "it runs a command inside the command"],
    ["{", "it uses brace expansion"],
    ["}", "it uses brace expansion"],
]);

const SUBSTITUTES = "it runs a command inside the command";
const EXPANDS = "a shell variable or expansion in it is only filled in when it runs";
const UNCLOSED = "a quote in it never closes";

// A `$` that starts an expansion: a name, a positional or special parameter, `${`, `$(` or `$'`.
const EXPANSION_START = /[A-Za-z_0-9{(@*#?$!'-]/;

// The lexer's position and the word it is building.
interface LexState {
    readonly source: string;
    readonly words: Word[];
    index: number;
    text: string;
    dynamic: boolean;
    started: boolean;
}

const finishWord = (state: LexState): void => {
    if (state.started) {
        state.words.push({ text: state.text, dynamic: state.dynamic });
    }
    state.text = "";
    state.dynamic = false;
    state.started = false;
};

// A single-quoted run: no escapes, no expansions.
const singleQuoted = (state: LexState): string | undefined => {
    const close = state.source.indexOf("'", state.index + 1);
    if (close === -1) {
        return UNCLOSED;
    }
    state.text += state.source.slice(state.index + 1, close);
    state.index = close + 1;
    return undefined;
};

// One character inside double quotes: `$name` marks the word dynamic, `$(` and backticks run a command.
const quotedChar = (state: LexState, at: number): { readonly next: number } | Unreadable => {
    const char = state.source.charAt(at);
    const following = state.source.charAt(at + 1);
    if (char === "\\" && following !== "") {
        state.text += following;
        return { next: at + 2 };
    }
    if (char === "`" || (char === "$" && following === "(")) {
        return { why: SUBSTITUTES };
    }
    state.dynamic ||= char === "$" && EXPANSION_START.test(following);
    state.text += char;
    return { next: at + 1 };
};

const doubleQuoted = (state: LexState): string | undefined => {
    let at = state.index + 1;
    while (at < state.source.length) {
        if (state.source.charAt(at) === `"`) {
            state.index = at + 1;
            return undefined;
        }
        const read = quotedChar(state, at);
        if ("why" in read) {
            return read.why;
        }
        at = read.next;
    }
    return UNCLOSED;
};

// A backslash outside quotes: the next character as itself, or, before a newline, a line continuation.
const escaped = (state: LexState): undefined => {
    const next = state.source.charAt(state.index + 1);
    state.index += 2;
    if (next === "\n") {
        finishWord(state);
        return undefined;
    }
    state.text += next;
    return undefined;
};

const plainChar = (state: LexState): undefined => {
    state.text += state.source.charAt(state.index);
    state.index += 1;
    return undefined;
};

const READERS: ReadonlyMap<string, (state: LexState) => string | undefined> = new Map([
    ["'", singleQuoted],
    [`"`, doubleQuoted],
    ["\\", escaped],
]);

const COMMENT = Symbol("comment");

// One step of reading: undefined to go on, COMMENT where the rest of the line is a comment, else why the command
// cannot be read.
const lexStep = (state: LexState): string | typeof COMMENT | undefined => {
    const char = state.source.charAt(state.index);
    if (char === " " || char === "\t") {
        finishWord(state);
        state.index += 1;
        return undefined;
    }
    if (char === "#" && !state.started) {
        return COMMENT;
    }
    const operator = OPERATORS.get(char);
    if (operator !== undefined) {
        return operator;
    }
    if (char === "$" && EXPANSION_START.test(state.source.charAt(state.index + 1))) {
        return EXPANDS;
    }
    state.started = true;
    return (READERS.get(char) ?? plainChar)(state);
};

// Splits one command into words the way a shell would, or says which shell feature makes that impossible to trust.
// Deliberately narrower than a shell: anything this does not model is a reason, not a guess.
const lex = (source: string): { readonly words: readonly Word[] } | Unreadable => {
    const state: LexState = { source, words: [], index: 0, text: "", dynamic: false, started: false };
    while (state.index < source.length) {
        const step = lexStep(state);
        if (step === COMMENT) {
            break;
        }
        if (step !== undefined) {
            return { why: step };
        }
    }
    finishWord(state);
    return { words: state.words };
};

// The host a URL names, past the scheme and any userinfo (a token spelled before an `@` is not the host), before the port
// and the path. Undefined when it is not a plain host a list could name.
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const urlHost = (url: string): string | undefined => {
    const authority = url.replace(URL_SCHEME, "").split(/[/?#]/)[0] ?? "";
    // A backslash is a separator to some URL parsers and userinfo to others, so the host after it is anybody's guess.
    if (authority.includes("\\")) {
        return undefined;
    }
    return normalizeHost(authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, ""));
};

// Whatever the programs below found: the hosts one would reach, or why they cannot be read.
type Reach = { readonly hosts: readonly string[] } | Unreadable;

// One argument a program connects to, read as its host.
const urlDestination = (word: Word, schemes: ReadonlySet<string>): { readonly host: string } | Unreadable => {
    if (word.dynamic) {
        return { why: "where it connects is filled in from a variable when it runs" };
    }
    const scheme = URL_SCHEME.exec(word.text)?.[1]?.toLowerCase();
    if (scheme !== undefined && !schemes.has(scheme)) {
        return { why: `it uses a ${scheme}:// address, which this check does not read` };
    }
    const host = urlHost(word.text);
    if (host === undefined) {
        return {
            why: word.text.includes(STAND_IN) ? "the secret is part of the address it connects to" : `the host in "${word.text}" cannot be read`,
        };
    }
    return { host };
};

// A flag table for one program: which flags take a value (read past, never as a destination), which name the
// destination, which change where it connects or keep the secret somewhere (each one a reason), and which are known to do
// none of that. A flag in none of them is a reason too: a table this narrow cannot vouch for what it has not read.
interface Flags {
    readonly values: ReadonlySet<string>;
    readonly destinations: ReadonlySet<string>;
    readonly steers: ReadonlyMap<string, string>;
    readonly plain: ReadonlySet<string>;
    // Whether it follows redirects unless told not to: wget does, and resends the headers it was given wherever they lead.
    readonly redirects: boolean;
}

const STEERS_PROXY = "it sends through a proxy or a changed address";
const STEERS_CONFIG = "it reads more options from a file";
const STEERS_REDIRECT = "it follows redirects, which can lead to any host";
const STEERS_TRUST = "it skips checking the server's certificate, so the host it names may not be the one that answers";
const STEERS_KEEPS = "it writes the request, secret included, somewhere a later command can read it";
const STEERS_VARIABLES = "it fills in parts of the command from variables when it runs";

const CURL: Flags = {
    values: new Set([
        ..."AbcCdDeEFHmoPQrtTuUwXyYz",
        "header",
        "data",
        "data-raw",
        "data-binary",
        "data-urlencode",
        "data-ascii",
        "json",
        "form",
        "form-string",
        "output",
        "output-dir",
        "user",
        "user-agent",
        "request",
        "cookie",
        "cookie-jar",
        "dump-header",
        "write-out",
        "max-time",
        "connect-timeout",
        "retry",
        "retry-delay",
        "retry-max-time",
        "range",
        "upload-file",
        "cacert",
        "capath",
        "cert",
        "key",
        "cert-type",
        "key-type",
        "pass",
        "oauth2-bearer",
        "referer",
        "limit-rate",
        "max-filesize",
        "url-query",
        "aws-sigv4",
        "time-cond",
        "speed-limit",
        "speed-time",
        "continue-at",
        "max-redirs",
        "local-port",
        "keepalive-time",
        "expect100-timeout",
        "tls-max",
        "ciphers",
        "proto",
        "proto-default",
        "proto-redir",
        "quote",
        "etag-save",
        "etag-compare",
        "hsts",
        "create-file-mode",
        "service-name",
        "netrc-file",
    ]),
    destinations: new Set(["url"]),
    steers: new Map([
        ...["x", "proxy", "preproxy", "proxy1.0", "socks4", "socks4a", "socks5", "socks5-hostname"].map((flag) => [flag, STEERS_PROXY] as const),
        ...["resolve", "connect-to", "doh-url", "dns-servers", "unix-socket", "abstract-unix-socket", "alt-svc"].map(
            (flag) => [flag, STEERS_PROXY] as const,
        ),
        ...["K", "config"].map((flag) => [flag, STEERS_CONFIG] as const),
        ...["L", "location", "location-trusted"].map((flag) => [flag, STEERS_REDIRECT] as const),
        ...["k", "insecure", "proxy-insecure", "doh-insecure"].map((flag) => [flag, STEERS_TRUST] as const),
        ...["trace", "trace-ascii", "libcurl", "stderr"].map((flag) => [flag, STEERS_KEEPS] as const),
        ["variable", STEERS_VARIABLES],
    ]),
    plain: new Set([
        ..."sSfiIvOJgGjlnNRZ012346aBMpq#:",
        "silent",
        "show-error",
        "fail",
        "fail-with-body",
        "fail-early",
        "compressed",
        "include",
        "show-headers",
        "verbose",
        "head",
        "get",
        "globoff",
        "http1.0",
        "http1.1",
        "http2",
        "http2-prior-knowledge",
        "http3",
        "no-progress-meter",
        "progress-bar",
        "remote-name",
        "remote-name-all",
        "remote-header-name",
        "no-buffer",
        "no-keepalive",
        "ipv4",
        "ipv6",
        "tcp-nodelay",
        "tr-encoding",
        "ssl-reqd",
        "tlsv1.2",
        "tlsv1.3",
        "create-dirs",
        "retry-all-errors",
        "retry-connrefused",
        "raw",
        "digest",
        "basic",
        "anyauth",
        "path-as-is",
        "parallel",
        "parallel-immediate",
        "next",
        "no-clobber",
        "remove-on-error",
        "disable",
        "styled-output",
        "no-styled-output",
        "list-only",
        "append",
    ]),
    redirects: false,
};

const WGET: Flags = {
    values: new Set([
        ..."OoaUPtTwQ",
        "output-document",
        "output-file",
        "append-output",
        "header",
        "post-data",
        "post-file",
        "body-data",
        "body-file",
        "method",
        "user",
        "password",
        "http-user",
        "http-password",
        "user-agent",
        "directory-prefix",
        "tries",
        "timeout",
        "wait",
        "referer",
        "load-cookies",
        "save-cookies",
        "quota",
        "limit-rate",
        "ca-certificate",
        "certificate",
        "private-key",
        "progress",
        "max-redirect",
    ]),
    destinations: new Set(),
    steers: new Map([
        ...["e", "execute", "config", "i", "input-file", "B", "base"].map((flag) => [flag, STEERS_CONFIG] as const),
        ["no-check-certificate", STEERS_TRUST],
        ...["r", "recursive", "m", "mirror", "p", "page-requisites", "H", "span-hosts"].map((flag) => [flag, STEERS_REDIRECT] as const),
    ]),
    plain: new Set([
        ..."qvSNc46",
        "quiet",
        "verbose",
        "nv",
        "no-verbose",
        "server-response",
        "continue",
        "timestamping",
        "content-disposition",
        "no-cache",
        "show-progress",
        "nc",
        "no-clobber",
        "spider",
        "inet4-only",
        "inet6-only",
    ]),
    redirects: true,
};

const takesValue = (flags: Flags, name: string): boolean => flags.values.has(name) || flags.destinations.has(name);

// Why a flag rules the command out, or undefined for one the table knows to be harmless. `shown` is how the command
// spelled it.
const flagReason = (flags: Flags, name: string, shown: string): string | undefined =>
    flags.steers.get(name) ??
    (takesValue(flags, name) || flags.plain.has(name) ? undefined : `it uses an option (${shown}) this check does not read`);

// What one flag word took: how many following words it used as its value, and that value.
interface FlagRead {
    readonly skip: number;
    readonly value?: { readonly name: string; readonly word: Word };
}

const valueRead = (name: string, shown: string, attached: Word | undefined, next: Word | undefined): FlagRead | Unreadable => {
    const word = attached ?? next;
    return word === undefined ? { why: `${shown} is missing its value` } : { skip: attached === undefined ? 1 : 0, value: { name, word } };
};

// `--name value` or `--name=value`.
const readLong = (flags: Flags, word: Word, next: Word | undefined): FlagRead | Unreadable => {
    const [name = "", attached] = word.text.slice(2).split(/=(.*)/s);
    const why = flagReason(flags, name, `--${name}`);
    if (why !== undefined) {
        return { why };
    }
    if (!takesValue(flags, name)) {
        return { skip: 0 };
    }
    return valueRead(name, `--${name}`, attached === undefined ? undefined : { text: attached, dynamic: word.dynamic }, next);
};

// A short cluster, `-sSo out.json`: switches, then at most one value-taking letter, whose value is the rest of the word
// or the next one.
const readShort = (flags: Flags, word: Word, next: Word | undefined): FlagRead | Unreadable => {
    for (let at = 1; at < word.text.length; at += 1) {
        const letter = word.text.charAt(at);
        const why = flagReason(flags, letter, `-${letter}`);
        if (why !== undefined) {
            return { why };
        }
        if (takesValue(flags, letter)) {
            const rest = word.text.slice(at + 1);
            return valueRead(letter, `-${letter}`, rest === "" ? undefined : { text: rest, dynamic: word.dynamic }, next);
        }
    }
    return { skip: 0 };
};

const readFlag = (flags: Flags, word: Word, next: Word | undefined): FlagRead | Unreadable | undefined => {
    if (word.text.startsWith("--")) {
        return readLong(flags, word, next);
    }
    return word.text.startsWith("-") && word.text.length > 1 ? readShort(flags, word, next) : undefined;
};

interface Parsed {
    readonly positionals: readonly Word[];
    readonly values: readonly { readonly name: string; readonly word: Word }[];
}

// Reads one program's arguments against its table; `--` ends the options.
const parseFlags = (args: readonly Word[], flags: Flags): Parsed | Unreadable => {
    const positionals: Word[] = [];
    const values: { readonly name: string; readonly word: Word }[] = [];
    let index = 0;
    for (let word = args.at(0); word !== undefined; word = args.at(index)) {
        if (word.text === "--") {
            positionals.push(...args.slice(index + 1));
            break;
        }
        const read = readFlag(flags, word, args.at(index + 1));
        if (read !== undefined && "why" in read) {
            return read;
        }
        if (read === undefined) {
            positionals.push(word);
        } else if (read.value !== undefined) {
            values.push(read.value);
        }
        index += 1 + (read?.skip ?? 0);
    }
    return { positionals, values };
};

const WEB_SCHEMES = new Set(["http", "https"]);

const hostsOf = (words: readonly Word[], schemes: ReadonlySet<string>): Reach => {
    const hosts: string[] = [];
    for (const word of words) {
        const found = urlDestination(word, schemes);
        if ("why" in found) {
            return found;
        }
        hosts.push(found.host);
    }
    return hosts.length === 0 ? { why: "it names no host it would connect to" } : { hosts };
};

// curl and wget take every positional as a URL, one without a scheme as http.
const fetcherReach = (args: readonly Word[], flags: Flags): Reach => {
    const parsed = parseFlags(args, flags);
    if ("why" in parsed) {
        return parsed;
    }
    const valueOf = (name: string): readonly Word[] => parsed.values.filter((value) => value.name === name).map((value) => value.word);
    if (flags.redirects && !valueOf("max-redirect").some((word) => word.text === "0")) {
        return { why: STEERS_REDIRECT };
    }
    return hostsOf([...parsed.positionals, ...[...flags.destinations].flatMap(valueOf)], WEB_SCHEMES);
};

// git's own options, before the subcommand: `-C` and the path ones take a value, `-c` sets any config (a proxy, a URL
// rewrite, a credential helper), and the rest are switches.
const GIT_GLOBAL_VALUES = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
const GIT_GLOBAL_SWITCHES = new Set(["--no-pager", "-P", "--bare", "--no-replace-objects", "--literal-pathspecs", "--no-optional-locks"]);
// The subcommands that talk to a remote named on the command line and keep nothing of it; clone is left out because it
// writes the address it cloned from, credentials included, into the new checkout's config.
const GIT_TRANSFERS = new Set(["push", "fetch", "pull", "ls-remote"]);
const GIT_SCHEMES = new Set(["http", "https", "ssh", "git"]);
// Options of those subcommands whose value is the next word, so it is not taken for the remote.
const GIT_VALUES = new Set([
    "--depth",
    "--deepen",
    "--shallow-since",
    "--shallow-exclude",
    "-o",
    "--push-option",
    "--server-option",
    "-j",
    "--jobs",
    "--negotiation-tip",
    "--refmap",
    "--filter",
    "-s",
    "--strategy",
    "-X",
    "--strategy-option",
]);
const RUNS_REMOTELY = "it runs another program on the remote end";
const RECORDS_REMOTE = "it records the remote, secret included, in the checkout's config";
// Options that run a program on either end instead of git's own, or keep the remote's address in the checkout.
const GIT_REASONS: ReadonlyMap<string, string> = new Map([
    ["--upload-pack", RUNS_REMOTELY],
    ["--receive-pack", RUNS_REMOTELY],
    ["--exec", RUNS_REMOTELY],
    ["-u", RECORDS_REMOTE],
    ["--set-upstream", RECORDS_REMOTE],
]);
const CONFIGURED_REMOTE = "it talks to a remote configured elsewhere, not one written in the command";
// scp-style `user@host:path`, the other spelling of an ssh remote.
const SCP_REMOTE = /^(?:[^\s@/:]+@)?([^\s@/:]+):(?!\/\/)/;

const gitGlobalReason = (text: string): string =>
    text.startsWith("-c") || text.startsWith("--config-env")
        ? "it sets git configuration for this run"
        : `it uses a git option (${text}) this check does not read`;

// The words from the subcommand on, past git's own options.
const gitGlobals = (args: readonly Word[]): { readonly rest: readonly Word[] } | Unreadable => {
    let index = 0;
    for (let word = args.at(0); word !== undefined; word = args.at(index)) {
        const { text } = word;
        if (!text.startsWith("-")) {
            return { rest: args.slice(index) };
        }
        if (GIT_GLOBAL_VALUES.has(text.split("=")[0] ?? text)) {
            index += text.includes("=") ? 1 : 2;
        } else if (GIT_GLOBAL_SWITCHES.has(text)) {
            index += 1;
        } else {
            return { why: gitGlobalReason(text) };
        }
    }
    return { rest: [] };
};

// A transfer's remote: `--repo`'s value where given, else its first positional.
const gitRemote = (args: readonly Word[]): { readonly remote: Word } | Unreadable => {
    const positionals: Word[] = [];
    let index = 0;
    for (let word = args.at(0); word !== undefined; word = args.at(index)) {
        const name = word.text.split("=")[0] ?? word.text;
        const reason = GIT_REASONS.get(name);
        if (reason !== undefined) {
            return { why: reason };
        }
        const repo =
            name === "--repo"
                ? word.text === name
                    ? args.at(index + 1)
                    : { text: word.text.slice("--repo=".length), dynamic: word.dynamic }
                : undefined;
        if (repo !== undefined) {
            positionals.unshift(repo);
        } else if (!word.text.startsWith("-")) {
            positionals.push(word);
        }
        index += GIT_VALUES.has(word.text) || (name === "--repo" && word.text === name) ? 2 : 1;
    }
    const [remote] = positionals;
    return remote === undefined ? { why: CONFIGURED_REMOTE } : { remote };
};

// A remote as a host: a URL, or scp's `host:path`. `<transport>::<address>` hands it to a helper program instead.
const gitRemoteHost = (remote: Word): Reach => {
    if (remote.text.includes("::")) {
        return { why: "it hands the remote to a git transport helper, which runs a program" };
    }
    if (URL_SCHEME.test(remote.text)) {
        return hostsOf([remote], GIT_SCHEMES);
    }
    const scp = SCP_REMOTE.exec(remote.text)?.[1];
    if (scp === undefined) {
        return { why: CONFIGURED_REMOTE };
    }
    const host = remote.dynamic ? undefined : normalizeHost(scp);
    return host === undefined ? { why: `the host in "${remote.text}" cannot be read` } : { hosts: [host] };
};

const gitReach = (args: readonly Word[]): Reach => {
    const globals = gitGlobals(args);
    if ("why" in globals) {
        return globals;
    }
    const [subcommand, ...rest] = globals.rest;
    if (subcommand?.text === "clone") {
        return { why: "git clone keeps the address it cloned from, secret included, in the new checkout" };
    }
    if (subcommand === undefined || !GIT_TRANSFERS.has(subcommand.text)) {
        return { why: `git ${subcommand?.text ?? ""} is not a push, fetch, pull or ls-remote with the remote written out` };
    }
    const found = gitRemote(rest);
    return "why" in found ? found : gitRemoteHost(found.remote);
};

// A Map, not an object: a program named `constructor` must find nothing, not Object's own.
const PROGRAMS: ReadonlyMap<string, (args: readonly Word[]) => Reach> = new Map([
    ["curl", (args: readonly Word[]) => fetcherReach(args, CURL)],
    ["wget", (args: readonly Word[]) => fetcherReach(args, WGET)],
    ["git", gitReach],
]);

// Every URL written anywhere in the text, a header or a body included: a list is a claim about every host the command
// names, not only the one the program is pointed at.
const URL_ANYWHERE = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]*/gi;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// The program the command runs and what its arguments reach, or why neither can be trusted.
const programReach = (words: readonly Word[]): Reach => {
    const [program, ...args] = words;
    if (program === undefined) {
        return { why: "it runs nothing" };
    }
    if (ENV_ASSIGNMENT.test(program.text)) {
        return { why: "it sets environment variables for the program, which can change where it connects" };
    }
    const reach = program.dynamic ? undefined : PROGRAMS.get(program.text);
    if (reach === undefined) {
        const named = program.text.includes(STAND_IN) ? "a program named by the secret" : `\`${program.text}\``;
        return { why: `it runs ${named}, and where that sends things is not in the command's text` };
    }
    return reach(args);
};

// Where a shell command would send what it carries: every host it names when its shape is simple enough to trust, else
// why not.
export const commandDestination = (command: string): Destination => {
    const text = command.trim().replace(REFERENCE, STAND_IN);
    const lexed = lex(text);
    const reach = "why" in lexed ? lexed : programReach(lexed.words);
    if ("why" in reach) {
        return unreadable(reach.why);
    }
    const hosts = new Set(reach.hosts);
    for (const match of text.matchAll(URL_ANYWHERE)) {
        const host = urlHost(match[0]);
        if (host === undefined) {
            return unreadable(`the host in "${match[0]}" cannot be read`);
        }
        hosts.add(host);
    }
    return { certain: true, hosts: [...hosts] };
};

// A script decides where it sends things as it runs; its text shows at most where it might.
export const SCRIPT_DESTINATION: Destination = unreadable("it is a script, and a script decides where it sends things as it runs");

// The page a value would be typed into: its host is the destination.
export const pageDestination = (url: string): Destination => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return unreadable("the page's address cannot be read");
    }
    const host = WEB_SCHEMES.has(parsed.protocol.slice(0, -1)) ? normalizeHost(parsed.hostname) : undefined;
    return host === undefined ? unreadable(`the page (${parsed.protocol}) has no host a list could name`) : { certain: true, hosts: [host] };
};
