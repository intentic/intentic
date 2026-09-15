import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { RemoteRef, RemoteRefs } from "@intentic/sandbox-contract";
import { gitAuthHeader } from "./git-checkout.js";

// What a repository offers, read over the wire without cloning it: `ls-remote` is one round trip and touches no disk,
// which is what lets an install form resolve a version while someone is still typing the URL into it.

// `HEAD` is asked for by name because `--heads`/`--tags` would filter the symref line out, and the symref line is the
// only thing that says which branch is the default.
const REF_PATTERNS = ["HEAD", "refs/heads/*", "refs/tags/*"] as const;

// A stalled fetch is aborted by git itself rather than by racing a timer, so no git process is left running behind an
// answer the form already gave up on.
const STALL_GUARD = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=20"] as const;

const SYMREF_LINE = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/;
const REF_LINE = /^([0-9a-f]{40})\s+refs\/(heads|tags)\/(.+?)(\^\{\})?$/;

export const parseRemoteRefs = (stdout: string): RemoteRefs => {
    let defaultBranch: string | undefined;
    const branches: RemoteRef[] = [];
    // An annotated tag is advertised twice, the tag object then `^{}` with the commit it wraps; keyed by name so the
    // peeled line wins whichever order they arrive in.
    const tags = new Map<string, { sha: string; peeled: boolean }>();
    for (const raw of stdout.split("\n")) {
        const line = raw.trim();
        const symref = SYMREF_LINE.exec(line);
        if (symref !== null) {
            defaultBranch = symref[1];
            continue;
        }
        const match = REF_LINE.exec(line);
        if (match === null) {
            continue;
        }
        const [, sha = "", scope, name = "", peel] = match;
        if (scope === "heads") {
            branches.push({ name, kind: "branch", sha });
            continue;
        }
        const peeled = peel !== undefined;
        if (peeled || !tags.has(name)) {
            tags.set(name, { sha, peeled });
        }
    }
    return {
        ...(defaultBranch === undefined ? {} : { defaultBranch }),
        refs: [...branches, ...[...tags].map(([name, tag]): RemoteRef => ({ name, kind: "tag", sha: tag.sha }))],
    };
};

// git's own words for a refusal are about credentials it was told not to ask for; these are the same refusals said in
// terms of the form the reader is looking at.
const refusalReason = (stderr: string, authenticated: boolean): string => {
    if (/terminal prompts disabled|could not read Username|Authentication failed|Invalid username or password/i.test(stderr)) {
        return authenticated
            ? "that repository refused the access token: check it has read access."
            : "that repository is private: add an access token with read access.";
    }
    if (/repository .* not found|Repository not found|not a git repository/i.test(stderr)) {
        return "there is no repository at that address.";
    }
    if (/Could not resolve host/i.test(stderr)) {
        return "that host does not resolve from this sandbox.";
    }
    if (/timed out|Connection refused|Failed to connect/i.test(stderr)) {
        return "that host did not answer.";
    }
    // git's last fatal line is more use than its whole transcript, and is the only part addressed to a person.
    return [...stderr.matchAll(/^fatal:\s*(.+)$/gim)].at(-1)?.[1]?.trim() ?? "the repository could not be read.";
};

export class RemoteRefsError extends Error {}

// Reads every branch and tag a remote advertises. `dir` is only somewhere for git to stand: the URL is explicit, so no
// repository is involved on this side.
export const readRemoteRefs = async (dir: string, url: string, token?: string, git: GitRunner = defaultGit): Promise<RemoteRefs> => {
    const protocol = URL.parse(url)?.protocol;
    if (protocol !== "http:" && protocol !== "https:") {
        throw new RemoteRefsError("Only http(s) repository URLs can be read: an ssh remote stops on a host-key prompt nobody can answer.");
    }
    try {
        // The token rides a header via GIT_CONFIG_* so it never lands in the URL, a pane log or git's own error text.
        const { stdout } = await git(dir, [...STALL_GUARD, "ls-remote", "--symref", url, ...REF_PATTERNS], {
            GIT_TERMINAL_PROMPT: "0",
            ...(token === undefined
                ? {}
                : { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: gitAuthHeader(token) }),
        });
        return parseRemoteRefs(stdout);
    } catch (error) {
        throw new RemoteRefsError(`Could not read ${url}: ${refusalReason(String((error as { stderr?: unknown }).stderr ?? ""), token !== undefined)}`);
    }
};
