import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { errnoCode } from "@intentic/base/errors";
import { exec } from "@intentic/base/git";
import { withManagedInclude } from "@intentic/base/ssh-config";
import { statePath } from "../../state-paths.js";
import { AGENT_HOME } from "./agent-domain.js";
import { SESSION_STATE } from "../worktree-paths.js";

// Persist a credential-free AGENT_HOME on history: Claude session links, sanitized git config, public SSH config/keys and read-only skills/browsers.
// Use the conversation's SSH agent socket for signing; never copy private credentials or git credential/include/SSH commands.
// The agent owns this tree: traverse directories via no-follow descriptors and write by temporary-file rename, replacing links rather than following.
// Remove wrong-type entries first so symlink or directory swaps by surviving processes cannot redirect daemon writes.

// The directories under the agent's HOME the view binds read-only from the daemon's (agent-domain-view.ts HOME_RESTORES).
export const RESTORE_MOUNT_POINTS = [".claude/skills", ".cache/ms-playwright"] as const;

const NO_FOLLOW_DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string): string => `/proc/self/fd/${String(fd)}/${name}`;

// Takes away whatever is at `name` in the directory: a link (never followed), a file, or a tree the agent made.
const removeAt = (dir: number, name: string): void => {
    rmSync(at(dir, name), { recursive: true, force: true });
};

// Makes `name` in `dir`; one made by someone else meanwhile is the next open's to judge.
const makeAt = (dir: number, name: string, mode: number): void => {
    try {
        mkdirSync(at(dir, name), { mode });
    } catch (error) {
        if (errnoCode(error) !== "EEXIST") {
            throw error;
        }
    }
};

// The directory `name` in `dir`, opened without following a link; made if absent, and remade if something else stood
// there. The caller closes the descriptor.
const directoryAt = (dir: number, name: string, mode = 0o755): number => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return openSync(at(dir, name), NO_FOLLOW_DIR);
        } catch (error) {
            const code = errnoCode(error);
            if (code === "ENOENT") {
                makeAt(dir, name, mode);
                continue;
            }
            if (code === "ELOOP" || code === "ENOTDIR") {
                removeAt(dir, name);
                continue;
            }
            throw error;
        }
    }
    throw new Error(`agent HOME: ${name} kept changing under the daemon`);
};

// Opens `rel` under the HOME root, one component at a time.
const openPath = (root: number, rel: string): number => {
    let current = root;
    for (const part of rel.split("/")) {
        const next = directoryAt(current, part);
        if (current !== root) {
            closeSync(current);
        }
        current = next;
    }
    return current;
};

const withPath = <T>(root: number, rel: string, use: (dir: number) => T): T => {
    const dir = rel === "" ? root : openPath(root, rel);
    try {
        return use(dir);
    } finally {
        if (dir !== root) {
            closeSync(dir);
        }
    }
};

// Written beside its name and renamed over it, so a link standing at the name is replaced rather than written through.
const writeAt = (dir: number, name: string, content: string, mode: number): void => {
    const temp = `.${name}.${randomBytes(6).toString("hex")}`;
    const fd = openSync(at(dir, temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
        writeSync(fd, content);
    } finally {
        closeSync(fd);
    }
    try {
        renameSync(at(dir, temp), at(dir, name));
    } catch (error) {
        removeAt(dir, temp);
        if (errnoCode(error) !== "EISDIR" && errnoCode(error) !== "ENOTEMPTY") {
            throw error;
        }
        // A directory the agent put at the name: taken away, and the file written again.
        removeAt(dir, name);
        writeAt(dir, name, content, mode);
    }
};

// A link at `name` naming `target`, whatever stood there before.
const linkAt = (dir: number, name: string, target: string): void => {
    try {
        if (lstatSync(at(dir, name)).isSymbolicLink() && readlinkSync(at(dir, name)) === target) {
            return;
        }
        removeAt(dir, name);
    } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
            throw error;
        }
    }
    try {
        symlinkSync(target, at(dir, name));
    } catch (error) {
        // Another domain starting at the same moment made the same link.
        if (errnoCode(error) !== "EEXIST" || readlinkSync(at(dir, name)) !== target) {
            throw error;
        }
    }
};

// What of the daemon's global git config a domain gets. Gone: the credential helper (the daemon's own store), includes
// (which name files in the daemon's HOME), and an ssh command (the domain's ssh is the system's, with its own agent).
const WITHHELD_GIT = [/^credential\./u, /^include\./u, /^includeif\./u, /^core\.sshcommand$/u];

/** `git config --list -z` output as entries, in order: `key\nvalue\0`. */
export const parseGitConfigList = (text: string): [string, string][] =>
    text
        .split("\0")
        .filter((record) => record !== "")
        .map((record) => {
            const newline = record.indexOf("\n");
            return newline === -1 ? [record, "true"] : [record.slice(0, newline), record.slice(newline + 1)];
        });

const quoteGitValue = (value: string): string =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\t", "\\t")}"`;

/** The agent's .gitconfig from the daemon's entries: withheld keys dropped, every directory declared safe. */
export const renderAgentGitconfig = (entries: readonly (readonly [string, string])[]): string => {
    const sections = new Map<string, string[]>();
    const add = (key: string, value: string): void => {
        // section[.subsection].variable, where only the subsection may hold dots.
        const first = key.indexOf(".");
        const last = key.lastIndexOf(".");
        if (first === -1) {
            return;
        }
        const section = key.slice(0, first);
        const variable = key.slice(last + 1);
        const subsection = last > first ? key.slice(first + 1, last) : undefined;
        if (!/^[A-Za-z0-9.-]+$/u.test(section) || !/^[A-Za-z][A-Za-z0-9-]*$/u.test(variable) || subsection?.includes("\n") === true) {
            return;
        }
        const header = subsection === undefined ? `[${section}]` : `[${section} "${subsection.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
        const lines = sections.get(header) ?? [];
        lines.push(`\t${variable} = ${quoteGitValue(value)}`);
        sections.set(header, lines);
    };
    for (const [key, value] of entries) {
        if (!WITHHELD_GIT.some((pattern) => pattern.test(key.toLowerCase()))) {
            add(key, value);
        }
    }
    add("safe.directory", "*");
    return `${[...sections].map(([header, lines]) => `${header}\n${lines.join("\n")}`).join("\n")}\n`;
};

// The daemon's own global git config, as git reads it (includes resolved), or nothing when it has none.
export const daemonGitConfig = async (): Promise<[string, string][]> => {
    try {
        const { stdout } = await exec("git", ["config", "--global", "--list", "-z"], { timeout: 10_000, encoding: "utf8" });
        return parseGitConfigList(stdout);
    } catch {
        // allow(silent-catch): git exits 1 for a missing global config, which gives a domain nothing to copy.
        return [];
    }
};

// A machine's alias file with its key path moved from the daemon's ssh dir to the agent's.
export const agentSshConf = (conf: string, daemonHosts: string, agentHosts: string): string =>
    conf.replaceAll(`"${daemonHosts}/`, `"${agentHosts}/`);

const PUBLIC_HOST_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:conf|pub)$/u;
const INCLUDED = "intentic-hosts/*.conf";

export interface AgentHomeOptions {
    // The HOME on the history volume (agent-domain-view.ts homeSource).
    readonly home: string;
    readonly workspaceRoot: string;
    readonly gitconfig: readonly (readonly [string, string])[];
    // The daemon's managed ssh host dir as its alias files name it (capabilities/ssh-hosts.ts hostsDir).
    readonly sshHosts: string;
    // Who must own the HOME on disk: root, whose files the domain's map shows as its own. A suite not run as root says.
    readonly owner?: number;
}

export const provisionAgentHome = (options: AgentHomeOptions): void => {
    const root = openSync(options.home, NO_FOLLOW_DIR);
    try {
        if (fstatSync(root).uid !== (options.owner ?? 0)) {
            throw new Error(`agent HOME is not root's own on disk: ${options.home}`);
        }
        const store = statePath(options.workspaceRoot, ".intentic/records/sessions/claude/");
        withPath(root, ".claude", (claude) => {
            for (const name of SESSION_STATE) {
                linkAt(claude, name, join(store, name));
            }
            writeAt(claude, "settings.json", `${JSON.stringify({ cleanupPeriodDays: 3650 }, undefined, 2)}\n`, 0o644);
        });
        for (const rel of RESTORE_MOUNT_POINTS) {
            withPath(root, rel, () => undefined);
        }
        writeAt(root, ".gitconfig", renderAgentGitconfig(options.gitconfig), 0o644);
        const agentHosts = join(AGENT_HOME, ".ssh", "intentic-hosts");
        withPath(root, ".ssh", (ssh) => {
            const current = (() => {
                try {
                    return lstatSync(at(ssh, "config")).isFile() ? readFileSync(at(ssh, "config"), "utf8") : "";
                } catch (error) {
                    if (errnoCode(error) === "ENOENT") {
                        return "";
                    }
                    throw error;
                }
            })();
            writeAt(ssh, "config", withManagedInclude(current, `Include ${INCLUDED}`, (path) => path === INCLUDED), 0o600);
        });
        const wanted = new Map<string, string>();
        let names: string[] = [];
        try {
            names = readdirSync(options.sshHosts);
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") {
                throw error;
            }
        }
        for (const name of names.filter((entry) => PUBLIC_HOST_FILE.test(entry))) {
            const source = join(options.sshHosts, name);
            if (!lstatSync(source).isFile()) {
                continue;
            }
            const text = readFileSync(source, "utf8");
            wanted.set(name, name.endsWith(".conf") ? agentSshConf(text, options.sshHosts, agentHosts) : text);
        }
        withPath(root, ".ssh/intentic-hosts", (hosts) => {
            for (const stale of readdirSync(at(hosts, ".")).filter((entry) => !wanted.has(entry))) {
                removeAt(hosts, stale);
            }
            for (const [name, text] of wanted) {
                writeAt(hosts, name, text, 0o644);
            }
        });
    } finally {
        closeSync(root);
    }
};
