import { isAbsolute, posix, relative } from "node:path";
import {
    type AgentEvent,
    inertRegions,
    isLive,
    STATE_GROUP_DIR,
    TURN_REACH_LIST_MAX,
    type ToolCallContent,
    type ToolCallStatus,
    type TurnReach,
} from "@intentic/sandbox-contract";
import { MAIN_MOUNT } from "../../conversations/worktrees/isolation.js";
import { SHARED_STATE } from "../../workload/worktree-paths.js";
import { commandExitCode } from "./agent-verification.js";

// Where a turn's work went besides its own branch, the half its frames can tell: files it wrote with its edit tools
// where every conversation reads them (the sandbox's live state, the owner's own checkout), and the pushes it made with
// git. Recorded on the conversation's card (AgentSummary.reach), never sent back to the model. What its shell wrote into
// an installed extension and the clones it left work in are read off git as the turn closes (turn-reach.ts).

export type LiveWrite = NonNullable<TurnReach["live"]>[number];
export type StrandedClone = NonNullable<TurnReach["stranded"]>[number];
export type PublishedPush = NonNullable<TurnReach["published"]>[number];

// How much of a push the card keeps: a command is a line, not a script.
const PUSH_COMMAND_CHARS = 200;

// The one shared-state group that is live: what every conversation runs from. Records, identity and secrets are shared
// too, but nothing there is work an owner would look for on a branch.
const LIVE_GROUP = STATE_GROUP_DIR.local;

// The shared-state group a workspace-relative path is in, if any.
const sharedGroupOf = (rel: string): string | undefined => SHARED_STATE.find((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));

// What a path an edit tool named is, if it is live: workspace-relative for the sandbox's live state, however it was
// reached, and as written for anything else under the owner's own checkout (MAIN_MOUNT, which is the workspace itself).
// Undefined for a path on the turn's branch, in shared state nobody works in, or outside the workspace. `root` is the tree as the agent sees it, which
// inside an isolated turn's namespace is its own worktree.
export const livePathOf = (raw: string, root: string): string | undefined => {
    const path = raw.trim().replaceAll("\\", "/");
    if (path === "") {
        return undefined;
    }
    if (path === MAIN_MOUNT || path.startsWith(`${MAIN_MOUNT}/`)) {
        const normal = posix.normalize(path);
        const rel = posix.relative(MAIN_MOUNT, normal);
        const group = sharedGroupOf(rel);
        if (group === undefined) {
            return normal;
        }
        return group === LIVE_GROUP ? rel : undefined;
    }
    const rel = isAbsolute(path) ? relative(root, path) : posix.normalize(path).replace(/^\.\//, "");
    if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        return undefined;
    }
    return sharedGroupOf(rel) === LIVE_GROUP ? rel : undefined;
};

// The installed extension a live path is in, by the folder its install keeps (.intentic/local/extensions/<id>), with an
// update's staging and previous copies read as the install itself.
const INSTALLED = new RegExp(`^${LIVE_GROUP.replaceAll(".", "\\.")}/extensions/([^/]+)(?:/|$)`);
const SIDE_COPY = /^\.(.+)\.(?:cloning|previous)$/;
export const installOf = (live: string): string | undefined => {
    const dir = INSTALLED.exec(live)?.[1];
    return dir === undefined ? undefined : (SIDE_COPY.exec(dir)?.[1] ?? dir);
};

// The workspace-relative folder an install keeps, as a live entry names it.
export const installPath = (dir: string): string => `${LIVE_GROUP}/extensions/${dir}`;

// Words that lead a patch's own list of what it changed ("update src/a.ts, add src/b.ts"); a path that escapes the
// workspace survives only there, since `locations` drops it.
const PATCH_VERBS = /^(?:add|create|update|modify|edit|write|delete|remove|move|rename)\s+(.+)$/i;

// Every path an edit-like call named: its locations, the diffs it carried, and its target read as a patch's list.
const writtenPaths = (event: Extract<AgentEvent, { kind: "tool_call" }>): string[] => {
    const located = (event.locations ?? []).map((location) => location.path);
    const diffed = (event.content ?? []).flatMap((entry) => (entry.type === "diff" ? [entry.path] : []));
    const targeted = (event.target ?? "")
        .split(", ")
        .map((piece) => piece.trim())
        .flatMap((piece) => {
            const named = PATCH_VERBS.exec(piece)?.[1] ?? piece;
            return named !== "" && !/\s/.test(named) ? [named] : [];
        });
    return [...new Set([...located, ...diffed, ...targeted])];
};

const WRITING = new Set(["edit", "delete", "move"]);

// Quotes around a word, or left on its edge by a command quoted whole (`bash -c 'git push origin main'`).
const unquote = (word: string): string => word.replace(/^['"]|['"]$/g, "");

// A word as the shell would end it: quoted whole, or up to whitespace or an operator.
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|()]+)`;
// `git`, its global options (`-C <dir>` among them), then `push`: each match is one push the command runs.
const GIT_PUSH = new RegExp(
    String.raw`(?<=^|[\s;&|(/'"])git((?:\s+(?:-C|-c|--git-dir|--work-tree|--namespace)\s+${WORD}|\s+--?[A-Za-z][\w-]*(?:=${WORD})?)*)\s+push(?=$|[\s;&|)])`,
    "g",
);
const GLOBAL_DIR = new RegExp(String.raw`-C\s+(${WORD})`, "g");
// A `cd <dir>` opening a statement, the folder every later statement on the line runs in.
const CD = new RegExp(String.raw`(?:^|[;&|(\n])\s*cd\s+(${WORD})(?=\s*(?:$|[;&|)\n]))`, "g");
// Where a push's own arguments end: the next statement.
const STATEMENT_END = /[;&|)\n]/;
// Options of `git push` that take a value as the next word.
const VALUED_PUSH_FLAGS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
// A push that sends nothing.
const DRY_RUN = new Set(["-n", "--dry-run"]);

const joined = (base: string | undefined, dir: string): string => (base === undefined || isAbsolute(dir) ? dir : posix.join(base, dir));

// The branch a refspec writes on the remote: its destination, or its source when it names one side.
const branchOf = (refspec: string): string | undefined => {
    const spec = refspec.replace(/^\+/, "");
    const side = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
    const branch = side.replace(/^refs\/heads\//, "");
    return branch === "" ? undefined : branch;
};

// Where a push sends its work, as its own arguments name it: the remote (positional, or `--repo`) and the branch its
// refspec writes. Undefined for a push that sends nothing.
const targetOf = (args: string): Pick<PublishedPush, "remote" | "branch"> | undefined => {
    const words = args
        .split(/\s+/)
        .filter((word) => word !== "")
        .map(unquote);
    if (words.some((word) => DRY_RUN.has(word))) {
        return undefined;
    }
    const positional: string[] = [];
    let repo: string | undefined;
    for (let index = 0; index < words.length; index += 1) {
        const word = words[index] as string;
        if (word.startsWith("--repo=")) {
            repo = word.slice("--repo=".length);
        } else if (VALUED_PUSH_FLAGS.has(word)) {
            repo = word === "--repo" ? words[index + 1] : repo;
            index += 1;
        } else if (!word.startsWith("-")) {
            positional.push(word);
        }
    }
    const remote = positional[0] ?? repo;
    const branch = positional[1] === undefined ? undefined : branchOf(positional[1]);
    return { ...(remote === undefined ? {} : { remote }), ...(branch === undefined ? {} : { branch }) };
};

// The folder a push at `start` runs in: the last `cd` ahead of it on the line, then each `-C` it was given on top.
const dirOf = (command: string, start: number, globals: string): string | undefined => {
    const cd = [...command.slice(0, start).matchAll(CD)].at(-1)?.[1];
    return [...globals.matchAll(GLOBAL_DIR)]
        .map((each) => unquote(each[1] as string))
        .reduce<string | undefined>((base, each) => joined(base, each), cd === undefined ? undefined : unquote(cd));
};

// Every `git push` a shell command runs, never one inside quoted text a program only prints or matches, with where it
// pushed from and to as far as the command itself says.
export const pushesIn = (command: string): PublishedPush[] => {
    const regions = inertRegions(command);
    return [...command.matchAll(GIT_PUSH)].flatMap((match): PublishedPush[] => {
        const start = match.index;
        if (!isLive({ start, end: start + match[0].length }, regions)) {
            return [];
        }
        const tail = command.slice(start + match[0].length);
        const endAt = tail.search(STATEMENT_END);
        const args = (endAt === -1 ? tail : tail.slice(0, endAt)).trim();
        const target = targetOf(args);
        if (target === undefined) {
            return [];
        }
        const dir = dirOf(command, start, match[1] ?? "");
        const text = `${match[0]} ${args}`.replaceAll(/\s+/g, " ").trim();
        return [{ ...(dir === undefined ? {} : { dir }), ...target, command: text.slice(0, PUSH_COMMAND_CHARS) }];
    });
};

// What the frames saw, deduped and in the order it happened.
export interface ReachFrames {
    readonly live: readonly string[];
    readonly published: readonly PublishedPush[];
}

export interface ReachFrameLedger {
    readonly note: (event: AgentEvent) => void;
    readonly reading: () => ReachFrames;
}

type TrackedReach = { readonly kind: "write"; readonly paths: readonly string[] } | { readonly kind: "command"; readonly command: string };

// Same shape as the proof ledgers: remembered when a call opens, noted when it settles. A write that failed changed
// nothing, and a push whose command failed published nothing, judged by its exit footer before its status, as a check is.
export const createReachFrameLedger = (root: string): ReachFrameLedger => {
    const live = new Set<string>();
    const published = new Map<string, PublishedPush>();
    const pending = new Map<string, TrackedReach>();
    const settle = (id: string, status: ToolCallStatus | undefined, content: readonly ToolCallContent[] | undefined): void => {
        if (status !== "completed" && status !== "failed") {
            return;
        }
        const call = pending.get(id);
        if (call === undefined) {
            return;
        }
        pending.delete(id);
        if (call.kind === "write") {
            if (status === "completed") {
                for (const path of call.paths) {
                    live.add(path);
                }
            }
            return;
        }
        const exit = commandExitCode(content?.find((entry) => entry.type === "text")?.text ?? "");
        if (exit === undefined ? status !== "completed" : exit !== 0) {
            return;
        }
        for (const push of pushesIn(call.command)) {
            published.set(JSON.stringify([push.dir, push.remote, push.branch, push.command]), push);
        }
    };
    const tracked = (event: Extract<AgentEvent, { kind: "tool_call" }>): TrackedReach | undefined => {
        if (WRITING.has(event.category)) {
            const paths = writtenPaths(event).flatMap((path) => {
                const livePath = livePathOf(path, root);
                return livePath === undefined ? [] : [livePath];
            });
            return paths.length > 0 ? { kind: "write", paths } : undefined;
        }
        return event.category === "execute" && event.target !== undefined && /\bpush\b/.test(event.target)
            ? { kind: "command", command: event.target }
            : undefined;
    };
    return {
        note: (event) => {
            if (event.kind === "tool_call_update") {
                settle(event.id, event.status, event.content);
                return;
            }
            if (event.kind !== "tool_call") {
                return;
            }
            const call = tracked(event);
            if (call === undefined) {
                return;
            }
            pending.set(event.id, call);
            settle(event.id, event.status, event.content);
        },
        reading: () => ({ live: [...live], published: [...published.values()] }),
    };
};

// Everything the turn's close found, both halves.
export interface ReachParts {
    // What its edit tools wrote live, from the frames.
    readonly framed: ReachFrames;
    // Installs the close read: each one that changed under the turn and stands changed, by its folder and manifest id.
    readonly installs: readonly { readonly dir: string; readonly extension: string | undefined }[];
    // Install folders the close could read at all, changed or not: for these git's reading replaces the frames'.
    readonly covered: ReadonlySet<string>;
    readonly stranded: readonly StrandedClone[];
}

// A list at the card's length, with how many it left out.
const capped = <T>(items: readonly T[]): { readonly list: T[]; readonly more: number } => ({
    list: items.slice(0, TURN_REACH_LIST_MAX),
    more: Math.max(0, items.length - TURN_REACH_LIST_MAX),
});

// The card's reach: only the exceptions, undefined when everything stayed on the branch. An install git could read is
// told by git, which sees what its shell wrote too and whether it was put back; its frames speak only for one it could
// not read.
export const composeReach = (parts: ReachParts, at: number): TurnReach | undefined => {
    const installs: LiveWrite[] = parts.installs.map((install) => ({
        path: installPath(install.dir),
        ...(install.extension === undefined ? {} : { extension: install.extension }),
    }));
    const loose: LiveWrite[] = parts.framed.live.flatMap((path) => {
        const install = installOf(path);
        return install !== undefined && parts.covered.has(install) ? [] : [{ path }];
    });
    const live = capped([...installs, ...loose]);
    const stranded = capped(parts.stranded);
    const published = capped(parts.framed.published);
    if (live.list.length === 0 && stranded.list.length === 0 && published.list.length === 0) {
        return undefined;
    }
    return {
        at,
        ...(live.list.length > 0 ? { live: live.list } : {}),
        ...(live.more > 0 ? { liveMore: live.more } : {}),
        ...(stranded.list.length > 0 ? { stranded: stranded.list } : {}),
        ...(stranded.more > 0 ? { strandedMore: stranded.more } : {}),
        ...(published.list.length > 0 ? { published: published.list } : {}),
        ...(published.more > 0 ? { publishedMore: published.more } : {}),
    };
};
