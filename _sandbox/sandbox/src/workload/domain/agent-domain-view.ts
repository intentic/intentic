import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { posix as path } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { shellQuote } from "@intentic/sandbox-run/quote";
import type { IsolationPlan } from "../../conversations/worktrees/isolation.js";
import { AGENT_GID, AGENT_HOME, AGENT_UID, type AgentDomainView } from "./agent-domain.js";
import { MAIN_MOUNT, PACKAGE_STORE, SHARED_STATE } from "../worktree-paths.js";

const STAGE = "/run/intentic-view";
const LEASE = "/run/intentic-domain";
const LEASE_STAGE = "/mnt/intentic-domain-lease";
const PRIVATE_STATE = [`${STATE_DIR}/secrets`, `${STATE_DIR}/identity`];
// The daemon endpoints every domain gets, shared with it through their group (AGENT_GID), never their owner. The pane
// door is not among them: it is the domain's own, in its run directory (domain-anchor.ts).
const RUN_FILES = ["agent.token", "room.sock"];
const PRIVATE_ROOTS = ["/root", "/tmp", "/run"];
// Where a domain's run directories live under the history root: one per conversation, bound at the same path inside
// and out, its `tmp` the domain's /tmp. Same path on purpose, as for a fenced sandbox: the daemon writes the Bash
// tool's command files and background job dirs there, and neither side translates a path for the other.
export const AGENT_RUN = "agent-run";
// Where a domain finds its own pane door (terminal/pane-door.ts), whichever socket the daemon opened for it: one per
// domain, in a directory only the daemon writes (DOOR_DIR), bound here like the other endpoints.
export const PANE_DOOR_PATH = "/run/intentic/panes.sock";
export const DOOR_DIR = "/run/intentic/doors";
// What of the daemon's own HOME a domain reads, read-only and unmapped: the product's skills, at the path the prompt
// names and where the CLI looks for a user's own (agent-home.ts makes that mount point), and the image's Playwright
// browsers. Nothing else under /root: it holds the daemon's git credentials, its state file and its ssh keys.
const DAEMON_HOME = "/root";
export const HOME_RESTORES: readonly { readonly rel: string; readonly targets: readonly string[] }[] = [
    { rel: ".claude/skills", targets: [path.join(DAEMON_HOME, ".claude/skills"), path.join(AGENT_HOME, ".claude/skills")] },
    { rel: ".cache/ms-playwright", targets: [path.join(AGENT_HOME, ".cache/ms-playwright")] },
];
type Kind = "directory" | "file";

export interface ViewMask { readonly path: string; readonly kind: Kind }
export interface ViewAlias { readonly source: string; readonly target: string; readonly kind: Kind }
export interface AgentGitMetadata {
    readonly repository: string;
    readonly pointer: ViewMask;
    readonly gitdir: string;
    readonly commonDir: string;
}
export interface SameHostMount { readonly device: string; readonly root: string; readonly target: string }

// This is a daemon-produced description, not an agent request. All sources and mountpoints have been checked before
// constructing it. Keeping compilation pure lets tests examine the boundary without creating a namespace or mount.
export interface PreparedAgentDomainView {
    readonly plan: IsolationPlan;
    readonly historyRoot: string;
    readonly scratch: string;
    readonly homeSource: string;
    // The domain's run directory (AGENT_RUN): bound at its own path, and its `tmp` child as /tmp.
    readonly run: string;
    // The domain's pane door socket (in DOOR_DIR), bound at PANE_DOOR_PATH.
    readonly door: string;
    // The HOME_RESTORES (by `rel`) the daemon's HOME has.
    readonly restores: readonly string[];
    readonly mainAliases: readonly string[];
    readonly worktreeAliases: readonly string[];
    readonly historyAliases: readonly ViewAlias[];
    readonly historyPaths: readonly string[];
    readonly shared: readonly string[];
    readonly shelf: boolean;
    readonly packageStore: boolean;
    readonly masks: readonly ViewMask[];
    readonly git: readonly AgentGitMetadata[];
    readonly gitAliases: readonly ViewAlias[];
    readonly endpoints: readonly string[];
    readonly readOnlyMounts: readonly string[];
}
export interface AgentDomainViewOptions {
    readonly plan: IsolationPlan;
    readonly historyRoot: string;
    readonly authRoot: string;
    // The run directory this domain gets (runDirOf), made here if it is not there yet.
    readonly run: string;
    // The pane door the daemon already listens on for this domain (DOOR_DIR).
    readonly door: string;
    readonly sshSocket?: string;
    // Include owner/netd endpoints placed outside the stock /run tree. Never inferred from an agent environment.
    readonly controlPaths?: readonly string[];
    // Explicit, daemon-selected children only. Git directories are restored separately, read-only and NOT idmapped.
    readonly agentHistory?: readonly string[];
    // Every directory under a checkout holding a `.git` entry, root-relative ("" is the root): the bounded walk the
    // daemon's own discovery makes (isolation.ts gitPointersIn), handed in by the layer that owns it.
    readonly gitPointersIn: (root: string) => Promise<string[]>;
}
export interface PreparedDomainView extends AgentDomainView { readonly cleanup: () => Promise<void> }

const fail = (message: string): never => { throw new Error(`agent domain view: ${message}`); };
const under = (child: string, parent: string): boolean => parent === "/" || child === parent || child.startsWith(`${parent}/`);
const intersects = (a: string, b: string): boolean => under(a, b) || under(b, a);
const unique = (values: readonly string[]): string[] => [...new Set(values)];
const shallow = (values: readonly string[]): string[] => unique(values).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
const cleanAbsolute = (value: string): string => {
    if (!path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f\x7f]/u.test(value) || value.startsWith("//") || (value !== "/" && value.endsWith("/"))) {
        fail(`expected an absolute clean path: ${JSON.stringify(value)}`);
    }
    return value;
};
const cleanRelative = (value: string, empty = false): string => {
    if ((value === "" && empty)) { return value; }
    if (value === "" || path.isAbsolute(value) || value === "." || path.normalize(value) !== value || value.endsWith("/") || value.split("/").includes("..") || /[\x00-\x1f\x7f]/u.test(value)) {
        fail(`invalid relative path: ${JSON.stringify(value)}`);
    }
    return value;
};
const overlayPath = (value: string): string => {
    cleanAbsolute(value);
    if (value.includes(":") || value.includes(",")) { fail(`overlay path contains a colon or comma: ${value}`); }
    return value;
};
const quote = shellQuote;
const bind = (source: string, target: string, idmap?: string): string =>
    `mount --bind${idmap === undefined ? "" : ` -o ${quote(`X-mount.idmap=${idmap}`)}`} -- ${quote(source)} ${quote(target)}`;
const pinTree = (target: string): string => `mount --rbind -- ${quote(target)} ${quote(target)}`;
const readOnly = (target: string): string => `mount -o remount,bind,ro -- ${quote(target)}`;

const decodeMountPath = (value: string): string => cleanAbsolute(value.replace(/\\(040|011|012|134)/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))));
export const parseSameHostMounts = (text: string): SameHostMount[] => text.trim().split("\n").map((line) => {
    const fields = line.split(" ");
    if (fields.length < 10 || !fields.includes("-") || !/^\d+:\d+$/u.test(fields[2] ?? "")) { return fail("invalid mountinfo"); }
    return { device: fields[2]!, root: decodeMountPath(fields[3]!), target: decodeMountPath(fields[4]!) };
});

// realpath alone cannot find bind aliases. Compare same-device filesystem roots from the daemon's mountinfo. Include
// independently mounted descendants too: a bind of auth/keys somewhere else must be masked, not just auth's root.
export const sameHostAliases = (source: string, mounts: readonly SameHostMount[], descendants: boolean): Omit<ViewAlias, "kind">[] => {
    cleanAbsolute(source);
    for (const mount of mounts) { cleanAbsolute(mount.root); cleanAbsolute(mount.target); }
    const containing = mounts.filter((mount) => under(source, mount.target)).sort((a, b) => b.target.length - a.target.length)[0];
    if (containing === undefined) { return fail(`no mount describes ${source}`); }
    const fsPath = path.join(containing.root, path.relative(containing.target, source));
    const found = new Map<string, Omit<ViewAlias, "kind">>();
    found.set(source, { source, target: source });
    for (const mount of mounts) {
        if (mount.device !== containing.device) { continue; }
        let alias: Omit<ViewAlias, "kind"> | undefined;
        if (under(fsPath, mount.root)) {
            alias = { source, target: path.join(mount.target, path.relative(mount.root, fsPath)) };
        } else if (descendants && under(mount.root, fsPath)) {
            alias = { source: path.join(source, path.relative(fsPath, mount.root)), target: mount.target };
        }
        if (alias === undefined) { continue; }
        // An intervening mount can hide the claimed alias. Do not mistake a same-device parent for the visible inode.
        const visible = mounts.filter((entry) => under(alias.target, entry.target)).sort((a, b) => b.target.length - a.target.length)[0];
        if (visible === undefined || visible.device !== mount.device || path.join(visible.root, path.relative(visible.target, alias.target)) !== path.join(containing.root, path.relative(containing.target, alias.source))) { continue; }
        const previous = found.get(alias.target);
        if (previous !== undefined && previous.source !== alias.source) { fail(`ambiguous alias: ${alias.target}`); }
        found.set(alias.target, alias);
    }
    if (descendants) {
        for (const mount of mounts.filter((entry) => entry.target !== source && under(entry.target, source))) {
            for (const alias of sameHostAliases(mount.target, mounts, false)) {
                if (under(alias.target, source)) { continue; }
                const previous = found.get(alias.target);
                if (previous !== undefined && previous.source !== alias.source) { fail(`ambiguous descendant alias: ${alias.target}`); }
                found.set(alias.target, alias);
            }
        }
    }
    return [...found.values()];
};

export interface AgentOverlayDirectory {
    readonly path: string;
    readonly uid: number;
    readonly gid: number;
    readonly device: number;
    readonly inode: number;
    readonly kind: "directory" | "file" | "symlink";
}
export const validateAgentOverlayDirectories = (upper: AgentOverlayDirectory, work: AgentOverlayDirectory, workEmpty: boolean): void => {
    overlayPath(upper.path); overlayPath(work.path);
    if (intersects(upper.path, work.path) || path.dirname(upper.path) !== path.dirname(work.path) ||
        [upper, work].some((dir) => dir.kind !== "directory" || dir.uid !== AGENT_UID || dir.gid !== AGENT_GID) ||
        upper.device !== work.device || upper.inode === work.inode || !workEmpty) { fail("unsafe overlay upper/work directories"); }
};

interface StageSource extends ViewMask { readonly stage: string }
interface ViewProgram { readonly sources: readonly StageSource[]; readonly script: (userNamespace: string) => string }
const historyAllowed = (value: string, root: string): boolean => {
    if (!under(value, root) || value === root) { return false; }
    const rel = path.relative(root, value);
    return ["agent-home", "agent-homes", "agent-containers", "agent-cache", AGENT_RUN].some((name) => under(rel, name)) ||
        (rel.startsWith("sessions/") && rel.split("/").length >= 2);
};

const validateRoots = (plan: IsolationPlan, historyRoot: string): void => {
    if (plan.fence !== undefined) { fail("fenced plans need their area boundary; this view cannot replace it"); }
    for (const value of [plan.root, plan.worktree, historyRoot, plan.overlays]) {
        cleanAbsolute(value);
        if (value === "/" || PRIVATE_ROOTS.some((root) => under(value, root)) || intersects(value, AGENT_HOME) || intersects(value, MAIN_MOUNT) || intersects(value, LEASE_STAGE)) { fail(`reserved root: ${value}`); }
    }
    overlayPath(plan.overlays);
    for (const rel of plan.mirrors) { cleanRelative(rel); overlayPath(path.join(MAIN_MOUNT, rel)); }
    if (intersects(plan.root, historyRoot) || (plan.root !== plan.worktree && intersects(plan.root, plan.worktree)) || intersects(plan.overlays, plan.root) || intersects(plan.overlays, plan.worktree)) { fail("overlapping workspace, history or overlay roots"); }
};

interface ViewRestore { readonly stage: string; readonly target: string }

// The run directory and the pane door, each where only the daemon could have put it.
const validateRunAndDoor = (input: PreparedAgentDomainView): void => {
    if (path.dirname(input.run) !== path.join(input.historyRoot, AGENT_RUN)) { fail(`run directory must be a child of ${AGENT_RUN}: ${input.run}`); }
    if (!input.historyPaths.includes(input.run)) { fail("the run directory must be bound at its own path"); }
    if (path.dirname(cleanAbsolute(input.door)) !== DOOR_DIR || !/^[A-Za-z0-9_-]+\.sock$/u.test(path.basename(input.door))) { fail(`pane door outside ${DOOR_DIR}: ${input.door}`); }
};

// Each restored path of the daemon's HOME, staged once and listed at every target it is shown at.
const stagedRestores = (rels: readonly string[], stageOf: (source: string) => string): ViewRestore[] =>
    unique(rels).flatMap((rel) => {
        const entry = HOME_RESTORES.find((candidate) => candidate.rel === rel);
        if (entry === undefined) { return fail(`not a restorable path of the daemon's HOME: ${rel}`); }
        const stage = stageOf(path.join(DAEMON_HOME, rel));
        return entry.targets.map((target) => ({ stage, target }));
    });

// A restore under the daemon's HOME lands on the tmpfs its mask becomes, so that HOME must be masked whole.
const assertRestoresMasked = (restores: readonly ViewRestore[], masks: readonly ViewMask[]): void => {
    const underHome = restores.some((restore) => under(restore.target, DAEMON_HOME));
    if (underHome && !masks.some((mask) => mask.path === DAEMON_HOME && mask.kind === "directory")) {
        fail("restores under the daemon's HOME need that HOME masked");
    }
};

// One mask's lines. A masked tree with part of it restored becomes an empty tmpfs holding the mount points, which then
// turns read-only; any other mask is the empty file or directory, read-only.
const maskLines = (mask: ViewMask, restores: readonly ViewRestore[]): string[] => {
    const inside = restores.filter((restore) => restore.target !== mask.path && under(restore.target, mask.path));
    if (mask.kind !== "directory" || inside.length === 0) {
        return [bind(path.join(STAGE, mask.kind === "directory" ? "empty-directory" : "empty-file"), mask.path), readOnly(mask.path)];
    }
    return [
        `mount -t tmpfs -o uid=0,gid=0,mode=0755,size=1m,nodev,nosuid tmpfs ${quote(mask.path)}`,
        ...inside.flatMap((restore) => [`mkdir -p ${quote(restore.target)}`, bind(restore.stage, restore.target), readOnly(restore.target)]),
        `mount -o remount,ro -- ${quote(mask.path)}`,
    ];
};

// Into the agent's HOME, onto mount points agent-home.ts made: after its writable bind, read-only, unmapped.
const homeRestoreLines = (restores: readonly ViewRestore[]): string[] =>
    restores.filter((entry) => under(entry.target, AGENT_HOME)).flatMap((restore) => [bind(restore.stage, restore.target), readOnly(restore.target)]);

const compileView = (input: PreparedAgentDomainView): ViewProgram => {
    const { plan, historyRoot, scratch } = input;
    validateRoots(plan, historyRoot);
    for (const value of [scratch, input.homeSource, input.run, ...input.mainAliases, ...input.worktreeAliases, ...input.historyPaths, ...input.endpoints, ...input.readOnlyMounts]) { cleanAbsolute(value); }
    if (PRIVATE_ROOTS.some((root) => under(scratch, root)) || intersects(scratch, AGENT_HOME) || intersects(scratch, MAIN_MOUNT) || intersects(scratch, LEASE_STAGE)) { fail(`reserved root: ${scratch}`); }
    if (!under(scratch, historyRoot) || scratch === historyRoot || intersects(scratch, plan.worktree) || intersects(scratch, plan.overlays)) { fail("scratch must be a private history child outside worktree and overlays"); }
    if (!historyAllowed(input.homeSource, historyRoot) || input.homeSource !== path.join(historyRoot, "agent-home")) { fail("agent HOME must be the dedicated history child"); }
    for (const value of input.historyPaths) { if (!historyAllowed(value, historyRoot)) { fail(`not an agent-accessible history child: ${value}`); } }
    validateRunAndDoor(input);
    const main = unique([MAIN_MOUNT, ...input.mainAliases]).filter((alias) => alias !== plan.root);
    const worktrees = unique([plan.root, plan.worktree, ...input.worktreeAliases,
        ...input.historyAliases.filter((alias) => under(plan.worktree, alias.source)).map((alias) => path.join(alias.target, path.relative(alias.source, plan.worktree))),
    ]);
    for (const alias of [...main, ...worktrees]) {
        if (alias === "/" || PRIVATE_ROOTS.some((root) => under(alias, root)) || intersects(alias, scratch) || intersects(alias, plan.overlays) || intersects(alias, LEASE_STAGE) || intersects(alias, AGENT_HOME)) { fail(`unsafe workspace alias: ${alias}`); }
    }
    if (main.some((alias) => worktrees.some((worktree) => intersects(alias, worktree)))) { fail("main/worktree aliases overlap"); }
    for (const group of [main, worktrees]) {
        if (group.some((a) => group.some((b) => a !== b && intersects(a, b)))) { fail("nested workspace aliases"); }
    }
    const mappings: ViewAlias[] = [
        ...main.map((target) => ({ source: plan.root, target, kind: "directory" as const })),
        ...worktrees.map((target) => ({ source: plan.worktree, target, kind: "directory" as const })),
        ...input.historyAliases,
        { source: input.homeSource, target: AGENT_HOME, kind: "directory" },
        ...input.gitAliases.filter((alias) => alias.source !== alias.target),
    ];
    for (const alias of input.historyAliases) {
        cleanAbsolute(alias.source); cleanAbsolute(alias.target);
        if (!under(alias.source, historyRoot) || alias.target === "/" || PRIVATE_ROOTS.some((root) => intersects(alias.target, root)) || intersects(alias.target, plan.root) || intersects(alias.target, MAIN_MOUNT) || intersects(alias.target, AGENT_HOME) || intersects(alias.target, LEASE_STAGE)) { fail(`unsafe history alias: ${alias.target}`); }
    }
    if (!input.historyAliases.some((alias) => alias.source === historyRoot && alias.target === historyRoot && alias.kind === "directory")) { fail("missing history root alias"); }
    const targetsOf = (source: string): string[] => {
        const roots = mappings.filter((alias) => under(source, alias.source));
        const targets = roots.map((alias) => path.join(alias.target, path.relative(alias.source, source)));
        if (!under(source, plan.root) && !under(source, plan.worktree) && !under(source, historyRoot)) { targets.push(source); }
        return unique(targets);
    };
    const sources: StageSource[] = [];
    const sourceOf = (source: string, kind: Kind): string => {
        cleanAbsolute(source);
        const found = sources.find((entry) => entry.path === source);
        if (found !== undefined) {
            if (found.kind !== kind) { fail(`inconsistent source kind: ${source}`); }
            return found.stage;
        }
        const stage = path.join(STAGE, "sources", String(sources.length));
        sources.push({ path: source, kind, stage });
        return stage;
    };
    const writable: { readonly source: string; readonly target: string; readonly idmap: boolean; readonly ro: boolean }[] = [];
    const addBind = (source: string, target: string, idmap = true, ro = false): void => {
        cleanAbsolute(target);
        const previous = writable.find((entry) => entry.target === target);
        if (previous !== undefined) {
            if (previous.source !== source || previous.idmap !== idmap || previous.ro !== ro) { fail(`conflicting binds: ${target}`); }
            return;
        }
        writable.push({ source, target, idmap, ro });
    };
    const mainSource = sourceOf(plan.root, "directory");
    const worktreeSource = sourceOf(plan.worktree, "directory");
    for (const target of main) { addBind(mainSource, target); }
    for (const target of worktrees) { addBind(worktreeSource, target); }
    const historyPaths = shallow([input.homeSource, ...input.historyPaths]);
    if (historyPaths.some((a) => historyPaths.some((b) => a !== b && under(a, b)))) { fail("nested agent history children"); }
    for (const source of historyPaths) {
        const staged = sourceOf(source, "directory");
        for (const target of targetsOf(source)) { addBind(staged, target); }
        for (const alias of input.historyAliases.filter((entry) => entry.source !== source && under(entry.source, source))) {
            addBind(sourceOf(alias.source, alias.kind), alias.target);
        }
    }
    addBind(sourceOf(input.homeSource, "directory"), AGENT_HOME);
    // Disk-backed rather than a tmpfs: a build's temp files must not come out of the container's memory.
    addBind(sourceOf(path.join(input.run, "tmp"), "directory"), "/tmp");
    for (const rel of input.shared) {
        cleanRelative(rel);
        if (!SHARED_STATE.includes(rel) || PRIVATE_STATE.some((secret) => intersects(rel, secret))) { fail(`unsafe shared state: ${rel}`); }
        const staged = sourceOf(path.join(plan.root, rel), "directory");
        for (const target of [...main, ...worktrees]) { addBind(staged, path.join(target, rel)); }
    }
    for (const [enabled, rel, ro] of [[input.shelf, "refs", true], [input.packageStore, PACKAGE_STORE, false]] as const) {
        if (!enabled) { continue; }
        const staged = sourceOf(path.join(plan.root, rel), "directory");
        for (const target of [...main, ...worktrees]) { addBind(staged, path.join(target, rel), true, ro); }
    }
    const endpoints = unique(input.endpoints);
    for (const endpoint of endpoints) {
        const rel = path.relative("/run/intentic", endpoint);
        if (!RUN_FILES.includes(rel) && !/^ssh\/(?:c-[A-Za-z0-9][A-Za-z0-9_-]*|none)\.[A-Za-z0-9_-]+\.sock$/u.test(rel)) { fail(`unapproved runtime endpoint: ${endpoint}`); }
        addBind(sourceOf(endpoint, "file"), endpoint, false, true);
    }
    if (RUN_FILES.some((name) => !endpoints.includes(`/run/intentic/${name}`)) || endpoints.filter((entry) => entry.startsWith("/run/intentic/ssh/")).length > 1) { fail("missing runtime endpoint or multiple conversation SSH sockets"); }
    addBind(sourceOf(input.door, "file"), PANE_DOOR_PATH, false, true);
    const restores = stagedRestores(input.restores, (source) => sourceOf(source, "directory"));
    const masks: ViewMask[] = [];
    const addMask = (target: string, kind: Kind): void => {
        cleanAbsolute(target);
        if (target === "/" || intersects(target, LEASE_STAGE) || target === LEASE || under(LEASE, target)) { fail(`mask hides the init lease: ${target}`); }
        const previous = masks.find((entry) => entry.path === target);
        if (previous !== undefined && previous.kind !== kind) { fail(`conflicting mask types: ${target}`); }
        if (previous === undefined) { masks.push({ path: target, kind }); }
    };
    for (const root of [...main, ...worktrees]) {
        for (const rel of PRIVATE_STATE) { addMask(path.join(root, rel), "directory"); }
    }
    for (const mask of input.masks) {
        for (const target of targetsOf(cleanAbsolute(mask.path))) {
            // /tmp and /run are replaced wholesale; masking either later would hide the intentionally fresh runtime.
            if (target !== "/tmp" && target !== "/run") { addMask(target, mask.kind); }
        }
        if (under(mask.path, plan.root)) {
            const rel = path.relative(plan.root, mask.path);
            for (const target of worktrees) { addMask(path.join(target, rel), mask.kind); }
        }
    }
    for (const mask of masks) {
        if (writable.some((entry) => under(entry.target, mask.path)) || intersects(mask.path, STAGE) || [AGENT_HOME, "/run/user/0", "/run/agent"].some((target) => under(target, mask.path))) { fail(`mask conflicts with an accessible path: ${mask.path}`); }
    }
    const pins = new Set<string>();
    const pinParents = (target: string): void => {
        const root = [...main, ...worktrees, AGENT_HOME, ...historyPaths.flatMap(targetsOf)].filter((entry) => under(target, entry)).sort((a, b) => b.length - a.length)[0];
        if (root === undefined) { return; }
        let parent = path.dirname(target);
        while (parent !== root && under(parent, root)) { pins.add(parent); parent = path.dirname(parent); }
    };
    const effectiveMasks = masks.filter((mask) => {
        if (under(mask.path, "/tmp") || under(mask.path, "/run")) { return false; }
        if (input.historyAliases.some((alias) => under(mask.path, alias.target)) && !writable.some((entry) => under(mask.path, entry.target))) { return false; }
        return !masks.some((parent) => parent !== mask && parent.kind === "directory" && under(mask.path, parent.path));
    });
    for (const mask of effectiveMasks) { pinParents(mask.path); }
    assertRestoresMasked(restores, effectiveMasks);
    const metadata: { readonly source: string; readonly target: string; readonly kind: Kind }[] = [];
    const addMetadata = (source: string, target: string, kind: Kind): void => {
        const staged = sourceOf(source, kind);
        if (masks.some((mask) => intersects(mask.path, target))) { fail(`Git metadata conflicts with mask: ${target}`); }
        if (writable.some((entry) => under(entry.target, target))) { fail(`Git metadata conflicts with writable view: ${target}`); }
        const previous = metadata.find((entry) => entry.target === target);
        if (previous !== undefined && (previous.source !== staged || previous.kind !== kind)) { fail(`conflicting Git metadata: ${target}`); }
        if (previous === undefined) { metadata.push({ source: staged, target, kind }); }
        pinParents(target);
    };
    for (const git of input.git) {
        cleanAbsolute(git.repository); cleanAbsolute(git.pointer.path); cleanAbsolute(git.gitdir); cleanAbsolute(git.commonDir);
        if (git.pointer.path !== path.join(git.repository, ".git")) { fail(`invalid Git pointer location: ${git.pointer.path}`); }
        for (const target of targetsOf(git.pointer.path)) { addMetadata(git.pointer.path, target, git.pointer.kind); }
        for (const source of unique([git.gitdir, git.commonDir])) {
            for (const target of targetsOf(source)) { addMetadata(source, target, "directory"); }
        }
    }
    for (const alias of input.gitAliases.filter((entry) => entry.source !== entry.target)) {
        cleanAbsolute(alias.source); cleanAbsolute(alias.target);
        if (!input.git.some((git) => under(alias.source, git.gitdir) || under(alias.source, git.commonDir) || alias.source === git.pointer.path)) { fail(`alias is not Git metadata: ${alias.source}`); }
        addMetadata(alias.source, alias.target, alias.kind);
    }
    if (![plan.root, plan.worktree].every((root) => input.git.some((git) => git.repository === root))) { fail("missing root Git metadata"); }
    const mirrors = shallow(plan.mirrors);
    const layers = mirrors.map((rel) => {
        cleanRelative(rel);
        if ([...PRIVATE_STATE, ".git", "refs", PACKAGE_STORE, ...SHARED_STATE].some((reserved) => intersects(rel, reserved)) || rel.split("/").includes(".git")) { fail(`mirror overlaps a protected path: ${rel}`); }
        const lower = overlayPath(path.join(MAIN_MOUNT, rel));
        const layer = path.join(plan.overlays, encodeURIComponent(rel));
        const upper = overlayPath(path.join(layer, "upper"));
        const work = overlayPath(path.join(layer, "work"));
        if (masks.some((mask) => intersects(mask.path, upper) || intersects(mask.path, work)) || input.git.some((git) => intersects(path.join(plan.worktree, rel), git.pointer.path) || intersects(path.join(plan.root, rel), git.pointer.path))) { fail(`overlay conflicts with protected metadata: ${rel}`); }
        // Plain binds of on-disk uid 1500 directories. Never idmap upper/work, or the overlay becomes read-only.
        return { rel, lower, upper: sourceOf(upper, "directory"), work: sourceOf(work, "directory") };
    });
    return {
        sources,
        script: (userNamespace) => {
            if (!/^\/proc\/[1-9]\d*\/ns\/user$/u.test(userNamespace)) { return fail("expected a daemon-held /proc/<pid>/ns/user idmapping path"); }
            // 066, not 077: the parents `mkdir -p` makes on the blank history and /root tmpfs must be traversable by the
            // domain (0711), or its run directory and restored skills sit behind a directory it cannot enter.
            const lines = ["set -eu", "export PATH=/usr/sbin:/usr/bin:/sbin:/bin", "umask 066", "mount --make-rprivate /"];
            for (const source of sources) { lines.push(bind(source.path, path.join(scratch, path.relative(STAGE, source.stage)))); }
            lines.push(`mkdir -p ${quote(MAIN_MOUNT)} ${quote(AGENT_HOME)}`);
            lines.push("mount -t tmpfs -o uid=0,gid=0,mode=0755,nodev,nosuid tmpfs /run", `mkdir -p ${quote(STAGE)}`, `chmod 0700 ${quote(STAGE)}`, `mount --rbind -- ${quote(scratch)} ${quote(STAGE)}`);
            // Image/root mounts stay unmapped and read-only. Each new writable view is a separate bind made afterward.
            // Read-only IN PLACE, never by stacking a copy first: a mount stacked over "/" is not where this script's
            // own lookups start, so everything it mounted after that landed beneath the copy, and every entrant (setns
            // lands on the topmost root) saw the copy with not one bind or mask in it. Found live on omen, 2026-10-08.
            for (const target of shallow(["/", ...input.readOnlyMounts]).toReversed()) {
                if (under(target, "/run") || under(target, LEASE_STAGE)) { continue; }
                lines.push(readOnly(target));
            }
            // POSIX shared memory is the domain's own, never the daemon's; the read-only pin above would refuse shm_open.
            lines.push(`if [ -d /dev/shm ]; then mount -t tmpfs -o uid=${String(AGENT_UID)},gid=${String(AGENT_GID)},mode=1777,nodev,nosuid,noexec tmpfs /dev/shm; fi`);
            for (const alias of input.historyAliases.toSorted((a, b) => a.target.length - b.target.length)) {
                if (input.historyAliases.some((parent) => parent.target !== alias.target && under(alias.target, parent.target))) {
                    lines.push(`mkdir -p ${quote(alias.kind === "directory" ? alias.target : path.dirname(alias.target))}`);
                    if (alias.kind === "file") { lines.push(`: > ${quote(alias.target)}`); }
                }
                if (alias.kind === "directory") { lines.push(`mount -t tmpfs -o uid=0,gid=0,mode=0711,nodev,nosuid tmpfs ${quote(alias.target)}`); }
                else { lines.push(bind(path.join(STAGE, "empty-file"), alias.target), readOnly(alias.target)); }
            }
            // These dirs exist in the image/prepared sources. Only the blank history and fresh /run are created here.
            for (const entry of writable) {
                if (entry.target.startsWith("/run/")) {
                    lines.push(`mkdir -p ${quote(path.dirname(entry.target))}`, `: > ${quote(entry.target)}`);
                } else if (input.historyAliases.some((alias) => under(entry.target, alias.target) && entry.target !== alias.target)) {
                    lines.push(`mkdir -p ${quote(entry.target)}`);
                }
                lines.push(bind(entry.source, entry.target, entry.idmap ? userNamespace : undefined));
                if (entry.ro) { lines.push(readOnly(entry.target)); }
            }
            for (const layer of layers) {
                const target = path.join(plan.root, layer.rel);
                lines.push(`mount -t overlay intentic-agent-modules -o ${quote(`lowerdir=${layer.lower},upperdir=${layer.upper},workdir=${layer.work}`)} -- ${quote(target)}`);
                for (const alias of worktrees.filter((entry) => entry !== plan.root)) { lines.push(bind(target, path.join(alias, layer.rel))); }
            }
            // Recursive pins preserve the shared/overlay mounts already below each ancestor. A plain self-bind would
            // hide them. Pin every writable ancestor, not just the .git inode. A renamed parent must not permit a replacement
            // pointer/config at the daemon's original pathname. Binding a directory does not make its files read-only.
            for (const target of shallow([...pins])) { lines.push(pinTree(target)); }
            for (const entry of metadata.toSorted((a, b) => a.target.length - b.target.length)) {
                const blankHistory = input.historyAliases.some((alias) => under(entry.target, alias.target)) &&
                    !writable.some((ancestor) => under(entry.target, ancestor.target)) &&
                    !metadata.some((ancestor) => ancestor !== entry && ancestor.kind === "directory" && under(entry.target, ancestor.target));
                if (blankHistory) {
                    lines.push(`mkdir -p ${quote(entry.kind === "directory" ? entry.target : path.dirname(entry.target))}`);
                    if (entry.kind === "file") { lines.push(`: > ${quote(entry.target)}`); }
                }
                lines.push(bind(entry.source, entry.target), readOnly(entry.target));
            }
            for (const mask of effectiveMasks.toSorted((a, b) => a.path.length - b.path.length)) { lines.push(...maskLines(mask, restores)); }
            lines.push(...homeRestoreLines(restores));
            for (const alias of input.historyAliases.filter((candidate) => candidate.kind === "directory" && !writable.some((entry) => entry.target === candidate.target))) { lines.push(readOnly(alias.target)); }
            lines.push(
                "mkdir -p /run/user/0 /run/agent/cache /run/intentic/ssh /run/intentic-domain",
                `chown ${String(AGENT_UID)}:${String(AGENT_GID)} /run/user/0 /run/agent /run/agent/cache`,
                "chmod 0700 /run/user/0 /run/agent /run/agent/cache",
                "chown 0:0 /run/user /run/intentic /run/intentic/ssh /run/intentic-domain",
                "chmod 0711 /run/user /run/intentic /run/intentic/ssh",
                "chmod 0700 /run/intentic-domain",
                readOnly(STAGE),
            );
            return lines.join("\n");
        },
    };
};

export const buildAgentDomainView = (input: PreparedAgentDomainView): AgentDomainView => {
    const program = compileView(input);
    return { cwd: input.plan.root, home: AGENT_HOME, scratch: input.scratch, script: program.script };
};

const kindOf = async (value: string): Promise<Kind> => {
    const entry = await lstat(value);
    if (entry.isSymbolicLink() || await realpath(value) !== value) { return fail(`symlink in mount path: ${value}`); }
    if (entry.isDirectory()) { return "directory"; }
    if (entry.isFile() || entry.isSocket()) { return "file"; }
    return fail(`unsupported mount source: ${value}`);
};
const directory = async (value: string): Promise<void> => {
    cleanAbsolute(value);
    if (await kindOf(value) !== "directory") { fail(`expected directory: ${value}`); }
};
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const exists = async (value: string): Promise<boolean> => {
    try { await lstat(value); return true; } catch (error) { if (missing(error)) { return false; } throw error; }
};
const ensureDirectoryPath = async (value: string): Promise<void> => {
    cleanAbsolute(value);
    if (await exists(value)) { await directory(value); return; }
    await ensureDirectoryPath(path.dirname(value));
    await mkdir(value, { mode: 0o755 });
    await directory(value);
};
const makeDirectory = async (value: string, uid = 0, mode = 0o700): Promise<void> => {
    cleanAbsolute(value);
    if (!await exists(value)) { await ensureDirectoryPath(path.dirname(value)); await mkdir(value, { mode }); }
    await directory(value);
    const entry = await lstat(value);
    if (entry.uid !== uid || (entry.mode & 0o022) !== 0) { fail(`directory is not controlled by uid ${String(uid)}: ${value}`); }
    await chown(value, uid, uid === AGENT_UID ? AGENT_GID : 0);
    await chmod(value, mode);
};
const trustedFile = async (value: string): Promise<string> => {
    const entry = await lstat(value);
    if (await kindOf(value) !== "file" || !entry.isFile() || entry.uid !== 0 || entry.nlink !== 1 || (entry.mode & 0o022) !== 0 || entry.size > 16384) { return fail(`unsafe Git pointer/config: ${value}`); }
    return readFile(value, "utf8");
};

// Parse files, never invoke Git: root Git must not read an attacker-selected config or hook during discovery.
export const resolveGitPointer = (text: string, pointer: string): string => {
    cleanAbsolute(pointer);
    const match = /^gitdir: ([^\r\n]+)\n?$/u.exec(text);
    if (match === null) { return fail(`invalid Git pointer: ${pointer}`); }
    const named = match[1]!;
    if (path.isAbsolute(named)) { return cleanAbsolute(named); }
    cleanRelative(named);
    return cleanAbsolute(path.join(path.dirname(pointer), named));
};
const discoverGit = async (repository: string, roots: readonly string[], historyRoot: string): Promise<AgentGitMetadata> => {
    const pointer = path.join(repository, ".git");
    const kind = await kindOf(pointer);
    const gitdir = kind === "directory" ? pointer : resolveGitPointer(await trustedFile(pointer), pointer);
    const allowed = (value: string): boolean => under(value, path.join(historyRoot, "gits")) || roots.some((root) => under(value, root) && path.relative(root, value).split("/").includes(".git"));
    const checkDir = async (value: string): Promise<void> => {
        if (!allowed(value)) { fail(`Git directory outside trusted backing roots: ${value}`); }
        await directory(value);
        const info = await lstat(value);
        if (info.uid !== 0 || (info.mode & 0o022) !== 0) { fail(`agent-writable Git directory: ${value}`); }
        for (const name of ["config", "config.worktree"]) { if (await exists(path.join(value, name))) { await trustedFile(path.join(value, name)); } }
        const hooks = path.join(value, "hooks");
        if (await exists(hooks)) {
            await directory(hooks);
            const checkHooks = async (dir: string): Promise<void> => {
                for (const entry of await readdir(dir, { withFileTypes: true })) {
                    const child = path.join(dir, entry.name);
                    if (entry.isDirectory()) { await directory(child); await checkHooks(child); }
                    else { await trustedFile(child); }
                }
            };
            await checkHooks(hooks);
        }
    };
    await checkDir(gitdir);
    await trustedFile(path.join(gitdir, "HEAD"));
    let commonDir = gitdir;
    const common = path.join(gitdir, "commondir");
    if (await exists(common)) {
        const named = (await trustedFile(common)).replace(/\n$/u, "");
        if (named === "" || /[\x00-\x1f\x7f]/u.test(named)) { fail(`invalid commondir: ${common}`); }
        commonDir = path.isAbsolute(named) ? cleanAbsolute(named) : path.resolve(gitdir, named);
        await checkDir(commonDir);
    }
    return { repository, pointer: { path: pointer, kind }, gitdir, commonDir };
};

// The repositories the daemon itself runs git in: the same bounded walk its own discovery makes (repo-discovery.ts,
// isolation.ts gitPointersIn), not a walk of the whole tree. A whole-tree walk read every node_modules and the pnpm
// store on every turn and refused the turn once it ran past its budget. A `.git` deeper than the daemon looks is one
// the daemon never runs git in. A repository the agent makes after its domain is built is NOT covered here: its
// metadata is the agent's to write, and the daemon's root git reading it is open (agent-domain-rollout.ts).
const viewGitPointers = async (gitPointersIn: AgentDomainViewOptions["gitPointersIn"], root: string, skipped: readonly string[]): Promise<string[]> =>
    (await gitPointersIn(root)).filter((rel) => !skipped.some((skip) => under(path.join(root, rel), skip)));

// The run directory's /tmp: sticky and world-writable like any /tmp, root-owned on disk (the agent's own through the map).
const ensureRunTmp = async (run: string): Promise<void> => {
    const runTmp = path.join(run, "tmp");
    if (!await exists(runTmp)) { await mkdir(runTmp, { mode: 0o700 }); }
    await directory(runTmp);
    if ((await lstat(runTmp)).uid !== 0) { fail(`run tmp is not root-owned: ${runTmp}`); }
    await chmod(runTmp, 0o1777);
};

// The HOME_RESTORES the daemon's HOME has, each a real directory.
const presentRestores = async (): Promise<string[]> => {
    const present: string[] = [];
    for (const { rel } of HOME_RESTORES) {
        if (await exists(path.join(DAEMON_HOME, rel))) {
            await directory(path.join(DAEMON_HOME, rel));
            present.push(rel);
        }
    }
    return present;
};

// A fixed daemon endpoint, never an arbitrary socket named by an agent. Bound into the domain unmapped, so its root
// reaches it as group AGENT_GID; the owner stays root.
const provisionEndpoint = async (endpoint: string): Promise<void> => {
    const entry = await lstat(endpoint);
    if (entry.uid !== 0 || entry.nlink !== 1) { fail(`daemon endpoint is not root's own: ${endpoint}`); }
    if (endpoint.endsWith("agent.token")) {
        if (!entry.isFile()) { fail(`unsafe agent token: ${endpoint}`); }
        await chown(endpoint, 0, AGENT_GID); await chmod(endpoint, 0o640);
        return;
    }
    if (!entry.isSocket()) { fail(`expected daemon socket: ${endpoint}`); }
    await chown(endpoint, 0, AGENT_GID); await chmod(endpoint, 0o660);
};

// Filesystem work only. The caller runs script() later in a separate daemon-owned mount namespace, then creates its
// PID namespace and enters the independently held userns. No namespace commands, probes, or Git execute here.
export const prepareAgentDomainView = async (options: AgentDomainViewOptions): Promise<PreparedDomainView> => {
    const { plan, historyRoot } = options;
    validateRoots(plan, historyRoot);
    for (const value of [plan.root, plan.worktree, plan.overlays, historyRoot, options.authRoot]) { cleanAbsolute(value); }
    if (plan.fence !== undefined) { return fail("fenced plans are not supported by this view"); }
    for (const value of [plan.root, plan.worktree, historyRoot]) { await directory(value); }
    const mounts = parseSameHostMounts(await readFile("/proc/self/mountinfo", "utf8"));
    const aliases = async (source: string, descendants: boolean): Promise<ViewAlias[]> => Promise.all(sameHostAliases(source, mounts, descendants).map(async (alias) => ({ ...alias, kind: await kindOf(alias.target) })));
    const historyAliases = await aliases(historyRoot, true);
    const mainAliases = (await aliases(plan.root, false)).map((alias) => alias.target).filter((alias) => alias !== plan.root);
    const worktreeAliases = (await aliases(plan.worktree, false)).map((alias) => alias.target);
    const auth = await realpath(options.authRoot);
    cleanAbsolute(auth);
    if (auth !== options.authRoot) { fail(`symlink in auth root: ${options.authRoot}`); }
    await directory(auth);
    if ([plan.root, plan.worktree, historyRoot, plan.overlays, AGENT_HOME, LEASE, LEASE_STAGE].some((value) => under(value, auth))) { fail(`auth root masks a required view path: ${auth}`); }
    const masks = [...await aliases(auth, true)].map((alias) => ({ path: alias.target, kind: alias.kind }));
    if (under(auth, plan.root)) { masks.push({ path: auth, kind: "directory" }); }
    for (const root of PRIVATE_ROOTS) { masks.push(...(await aliases(root, true)).map((alias) => ({ path: alias.target, kind: alias.kind }))); }
    for (const control of options.controlPaths ?? ["/run/intentic/netd.sock", "/run/intentic/node.sock", "/run/intentic/ssh/owner.sock"]) {
        cleanAbsolute(control);
        if (await exists(control)) { masks.push(...(await aliases(control, true)).map((alias) => ({ path: alias.target, kind: alias.kind }))); }
    }
    const homeSource = path.join(historyRoot, "agent-home");
    const run = cleanAbsolute(options.run);
    const historyPaths = [...(options.agentHistory ?? [path.join(historyRoot, "agent-homes"), path.join(historyRoot, "agent-containers")]), run];
    for (const value of [homeSource, ...historyPaths]) {
        cleanAbsolute(value);
        if (!historyAllowed(value, historyRoot)) { fail(`not an agent history child: ${value}`); }
        // Parents remain daemon-controlled; only the child mount is mapped into the domain.
        if (!await exists(path.dirname(value))) { await makeDirectory(path.dirname(value)); }
        await makeDirectory(value);
    }
    await ensureRunTmp(run);
    for (const root of unique([plan.root, plan.worktree])) {
        if (!await exists(path.join(root, STATE_DIR))) { await makeDirectory(path.join(root, STATE_DIR)); }
        for (const rel of PRIVATE_STATE) {
            if (!await exists(path.join(root, rel))) { await makeDirectory(path.join(root, rel)); }
            await directory(path.join(root, rel));
            masks.push(...(await aliases(path.join(root, rel), true)).map((alias) => ({ path: alias.target, kind: alias.kind })));
        }
    }
    // A custom workspace auth root must also be blocked at the corresponding worktree path, even if absent there.
    for (const mask of masks.filter((entry) => under(entry.path, plan.root))) {
        const counterpart = path.join(plan.worktree, path.relative(plan.root, mask.path));
        if (mask.kind === "directory") { await ensureDirectoryPath(counterpart); }
        else if (!await exists(counterpart)) {
            await ensureDirectoryPath(path.dirname(counterpart));
            await writeFile(counterpart, "", { flag: "wx", mode: 0o600 });
        }
    }
    const git: AgentGitMetadata[] = [];
    const gitAliases: ViewAlias[] = [];
    for (const root of unique([plan.root, plan.worktree])) {
        const pointers = await viewGitPointers(options.gitPointersIn, root, [
            ...PRIVATE_STATE.map((rel) => path.join(root, rel)), ...plan.mirrors.map((rel) => path.join(root, rel)), path.join(root, "refs"),
            ...(under(auth, root) ? [auth] : []),
            ...(root === plan.worktree && root !== plan.root ? SHARED_STATE.map((rel) => path.join(root, rel)) : []),
        ]);
        if (!pointers.includes("")) { fail(`missing root .git pointer: ${root}`); }
        for (const rel of pointers) { cleanRelative(rel, true); git.push(await discoverGit(path.join(root, rel), [plan.root, plan.worktree], historyRoot)); }
    }
    for (const source of unique(git.flatMap((entry) => [entry.pointer.path, entry.gitdir, entry.commonDir]))) { gitAliases.push(...await aliases(source, true)); }
    const shared: string[] = [];
    for (const rel of SHARED_STATE.filter((entry) => !PRIVATE_STATE.includes(entry))) {
        if (await exists(path.join(plan.root, rel))) {
            await directory(path.join(plan.root, rel));
            for (const root of unique([plan.root, plan.worktree])) {
                const target = path.join(root, rel);
                if (!await exists(target)) { await ensureDirectoryPath(target); }
                await directory(target);
            }
            shared.push(rel);
        }
    }
    const shelf = await exists(path.join(plan.root, "refs"));
    const packageStore = await exists(path.join(plan.root, PACKAGE_STORE));
    for (const rel of [...plan.mirrors, ...(shelf ? ["refs"] : []), ...(packageStore ? [PACKAGE_STORE] : [])]) {
        cleanRelative(rel);
        await directory(path.join(plan.root, rel));
        const target = path.join(plan.worktree, rel);
        if (!await exists(target)) { await ensureDirectoryPath(target); }
        await directory(target);
    }
    await makeDirectory(plan.overlays);
    for (const rel of plan.mirrors) {
        const layer = overlayPath(path.join(plan.overlays, encodeURIComponent(cleanRelative(rel))));
        await makeDirectory(layer);
        for (const part of ["upper", "work"]) {
            const target = path.join(layer, part);
            if (!await exists(target)) { await mkdir(target, { mode: 0o700 }); await chown(target, AGENT_UID, AGENT_GID); }
            await makeDirectory(target, AGENT_UID);
        }
        const upper = await lstat(path.join(layer, "upper"));
        const work = await lstat(path.join(layer, "work"));
        validateAgentOverlayDirectories(
            { path: path.join(layer, "upper"), uid: upper.uid, gid: upper.gid, device: upper.dev, inode: upper.ino, kind: upper.isDirectory() ? "directory" : "file" },
            { path: path.join(layer, "work"), uid: work.uid, gid: work.gid, device: work.dev, inode: work.ino, kind: work.isDirectory() ? "directory" : "file" },
            (await readdir(path.join(layer, "work"))).length === 0,
        );
    }
    const endpoints = RUN_FILES.map((name) => `/run/intentic/${name}`);
    if (options.sshSocket !== undefined) { endpoints.push(cleanAbsolute(options.sshSocket)); }
    const scratch = await mkdtemp(path.join(historyRoot, "agent-domain-"));
    await chown(scratch, 0, 0); await chmod(scratch, 0o700);
    const cleanup = async (): Promise<void> => { await rm(scratch, { recursive: true, force: true }); };
    try {
        const input: PreparedAgentDomainView = { plan, historyRoot, scratch, homeSource, run, door: options.door, restores: await presentRestores(), mainAliases, worktreeAliases, historyAliases, historyPaths, shared, shelf, packageStore, masks, git, gitAliases, endpoints, readOnlyMounts: mounts.map((mount) => mount.target) };
        const program = compileView(input);
        for (const source of program.sources) {
            for (const mount of mounts.filter((entry) => entry.target !== source.path && under(entry.target, source.path))) {
                if (!program.sources.some((entry) => entry.path === mount.target) && !masks.some((mask) => under(mount.target, mask.path))) { fail(`unstaged nested mount: ${mount.target}`); }
            }
        }
        await makeDirectory(path.join(scratch, "sources"));
        await makeDirectory(path.join(scratch, "empty-directory"));
        // Readable and empty, not unreadable: a masked path reads as nothing there, and a tool walking the tree (git
        // status) does not warn on every masked directory. Root-owned, so the domain cannot add anything to either.
        await chmod(path.join(scratch, "empty-directory"), 0o555);
        await writeFile(path.join(scratch, "empty-file"), "", { flag: "wx", mode: 0o444 });
        for (const source of program.sources) {
            await kindOf(source.path);
            const target = path.join(scratch, path.relative(STAGE, source.stage));
            if (source.kind === "directory") { await makeDirectory(target); }
            else { await writeFile(target, "", { flag: "wx", mode: 0o600 }); }
        }
        for (const endpoint of [...endpoints, options.door]) { await provisionEndpoint(endpoint); }
        return { cwd: plan.root, home: AGENT_HOME, scratch, script: program.script, cleanup };
    } catch (error) { await cleanup(); throw error; }
};
