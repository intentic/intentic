import { normalizeHost } from "@intentic/sandbox-contract";
import { hostsOf, URL_SCHEME } from "./secret-command-hosts.js";
import type { ProgramReader, Reach, Unreadable, Word } from "./secret-command-words.js";

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

// git reads only as a transfer to a remote written out in the command.
export const gitReach: ProgramReader = (args) => {
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
