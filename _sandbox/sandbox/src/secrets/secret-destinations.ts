import { normalizeHost, SECRET_REFERENCE } from "@intentic/sandbox-contract";
import { type Flags, parseFlags } from "./destinations/secret-command-flags.js";
import { lex, STAND_IN, type Unreadable, type Word } from "./destinations/secret-command-lex.js";
import { UTILITY_READERS } from "./destinations/secret-command-utilities.js";

// Where one use of a secret would send it, read from the reference-form text before anything runs, for the host limit
// (host-guard-gate.ts). Heuristic by nature, so it reads the other way round from a classifier: it proves nothing, and
// every doubt is an answer of its own. `certain` is only ever said when a line splits into stages the reader can account
// for one by one — a program whose destination sits in its arguments (curl, wget, git), a bare literal assignment, or a
// utility that opens no socket and runs nothing (jq, grep, head, cd, echo, …) — joined by the plain separators `|`, `&`,
// `;` and newline. A value reaches a host only through the stage that spells it, so a line every stage of which the
// reader can name sends nowhere it does not name: `certain` collects the hosts of every stage, and one unreadable stage
// (an interpreter, a subshell, a redirect, a run-time expansion in the wrong place) leaves the whole line unreadable.
// That is "every host the text names is these", never "this is safe"; the owner's list decides the rest. The machine is
// not read at all: a .curlrc, a git config or /etc/hosts can still point a named host elsewhere.

export type Destination =
    // Every host the use names; empty when every stage is read and none connects anywhere (a value that stays inside).
    | { readonly certain: true; readonly hosts: readonly string[] }
    // Why it cannot be read, as a clause that finishes "…because ": the card and the refusal both say it.
    | { readonly certain: false; readonly why: string };

const unreadable = (why: string): Destination => ({ certain: false, why });

const REFERENCE = new RegExp(SECRET_REFERENCE.source, "g");

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

interface FetcherFlags extends Flags {
    readonly destinations: ReadonlySet<string>;
    // wget follows redirects unless told not to, resending the headers it was given wherever they lead.
    readonly redirects: boolean;
    readonly writeOut: ReadonlySet<string>;
}
const STEERS_PROXY = "it sends through a proxy or a changed address";
const STEERS_CONFIG = "it reads more options from a file";
const STEERS_REDIRECT = "it follows redirects, which can lead to any host";
const STEERS_TRUST = "it skips checking the server's certificate, so the host it names may not be the one that answers";
const STEERS_KEEPS = "it writes the request, secret included, somewhere a later command can read it";
const STEERS_VARIABLES = "it fills in parts of the command from variables when it runs";

const CURL: FetcherFlags = {
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
        "url",
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
    writeOut: new Set(["w", "write-out"]),
};

const WGET: FetcherFlags = {
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
    writeOut: new Set(),
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
const fetcherReach = (args: readonly Word[], flags: FetcherFlags): Reach => {
    const parsed = parseFlags(args, flags);
    if ("why" in parsed) {
        return parsed;
    }
    const valueOf = (name: string): readonly Word[] => parsed.values.filter((value) => value.name === name).map((value) => value.word);
    if (flags.redirects && valueOf("max-redirect").at(-1)?.text !== "0") {
        return { why: STEERS_REDIRECT };
    }
    // curl's write-out is a small language, not just text to print. A template from a file / runtime value is unread,
    // and %output{...} opens a file. %% escapes a literal percent and cannot introduce that directive.
    for (const word of [...flags.writeOut].flatMap(valueOf)) {
        const writes = [...word.text.matchAll(/%%|%output\{/g)].some((match) => match[0] !== "%%");
        if (word.dynamic || word.text.includes(STAND_IN) || word.text.startsWith("@") || writes) {
            return { why: STEERS_KEEPS };
        }
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
    ...UTILITY_READERS,
    ["curl", (args: readonly Word[]) => fetcherReach(args, CURL)],
    ["wget", (args: readonly Word[]) => fetcherReach(args, WGET)],
    ["git", gitReach],
]);

// Programs a stage may run and still send the value nowhere: they open no socket, run no other program, and change no
// setting (a proxy, a config file, an alias, a PATH) a later stage's curl, wget or git would read. A stage of one of
// these adds no host and hides none, so it neither carries the value out nor sets up a later stage to. What is left out
// is deliberate: an interpreter (`python`, `node`, `perl`, `ruby`), a shell (`sh`, `bash`, `eval`, `source`), `awk` and
// `sed` (each runs a command or opens a socket in some form), `xargs`, `find`, `env`, `tee`, `nc`, `ssh`, `docker` and
// `gh` all stay unread, so a line that uses one still asks. A name not here is unknown, and leaves the line unreadable.
const INERT_PROGRAMS: ReadonlySet<string> = new Set([
    "cd",
    "pwd",
    "echo",
    "true",
    "false",
    ":",
    "test",
    "[",
    "sleep",
    "date",
    "mkdir",
    "ls",
    "dirname",
    "basename",
    "cat",
    "head",
    "tail",
    "wc",
    "cut",
    "tr",
    "nl",
    "rev",
    "tac",
    "fold",
    "column",
    "base64",
    "grep",
    "egrep",
    "fgrep",
    "jq",
    "comm",
]);

// Every URL written anywhere in the text, a header or a body included: a list is a claim about every host the command
// names, not only the one the program is pointed at. It ends where the shell would end a word (`;`, `|`, a redirect), so
// `R=https://host;` reads as `host`.
const URL_ANYWHERE = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`);|<>]*/gi;

// The program one stage runs and what its arguments reach, or why neither can be trusted.
const programReach = (words: readonly Word[]): Reach => {
    const [program, ...args] = words;
    if (program === undefined) {
        return { why: "it runs nothing" };
    }
    if (program.assignment === true) {
        if (words.some((word) => word.assignment === true && word.text.startsWith("PATH="))) {
            return { why: "it changes PATH, which can change which program runs" };
        }
        // A stage that is only `NAME=value` literals sets shell variables and runs nothing, so it sends nothing and
        // steers nothing (an unexported name reaches no later program's environment). One with a program after the
        // assignments puts them in that program's environment, which can change where it connects; a value filled in at
        // run time (`A="$B"`) is not a literal the reader can stand behind.
        return words.every((word) => word.assignment === true && !word.dynamic)
            ? { hosts: [] }
            : { why: "it sets environment variables for the program, which can change where it connects" };
    }
    if (!program.dynamic && INERT_PROGRAMS.has(program.text)) {
        return { hosts: [] };
    }
    const reach = program.dynamic ? undefined : PROGRAMS.get(program.text);
    if (reach === undefined) {
        const named = program.text.includes(STAND_IN) ? "a program named by the secret" : `\`${program.text}\``;
        return { why: `it runs ${named}, and where that sends things is not in the command's text` };
    }
    return reach(args);
};

// Where a shell command would send what it carries: every host it names when every stage is one the reader can account
// for, else why not. One unreadable stage answers for the whole line, since what it does with the value cannot be read.
export const commandDestination = (command: string): Destination => {
    const text = command.trim().replace(REFERENCE, STAND_IN);
    const lexed = lex(text);
    if ("why" in lexed) {
        return unreadable(lexed.why);
    }
    const hosts = new Set<string>();
    for (const segment of lexed.segments) {
        const reach = programReach(segment);
        if ("why" in reach) {
            return unreadable(reach.why);
        }
        for (const host of reach.hosts) {
            hosts.add(host);
        }
    }
    // Read URLs from shell words too: escapes/continuations are already resolved, while comments are gone. Scanning
    // the raw source again would contradict the lexer for escaped URLs and count addresses in discarded comments.
    for (const word of lexed.segments.flat()) {
        for (const match of word.text.matchAll(URL_ANYWHERE)) {
            const host = urlHost(match[0]);
            if (host === undefined) {
                return unreadable(`the host in "${match[0]}" cannot be read`);
            }
            hosts.add(host);
        }
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
