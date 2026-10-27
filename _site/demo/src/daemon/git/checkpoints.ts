import type { ChangeStatus } from "@intentic/sandbox-contract/schemas/git/git";
import type { FileDiff, Snapshot, SnapshotChange, SnapshotDiff, SnapshotsList, SnapshotTrigger } from "@intentic/sandbox-contract/schemas/history";
import { refuse } from "@intentic/contract-serve";
import { fileDiff, worktreeChanges } from "../../fixture/workspace";
import { freshEdition, deskEdition } from "../../mode";
import { pendingKeys, restorePending } from "./gitIndex";
import { checkpointId } from "./gitSha";
import { sidesOf } from "./gitReads";
import { listeners, STARTED_AT } from "../board/roster";

// The workspace's checkpoints (the history routes): saved points of the whole tree, each holding which of the
// recording's changed files were pending then. A turn's point is labelled with its prompt; every git verb that moves the
// tree takes a `user` point first, as the daemon's do (git.routes.ts), so a checkout or a reset lands on this timeline.
// Restoring puts the pending set back as it stood, with a pre-restore point before it and a restore point after it,
// since history is append-only. The files' two sides come from the recording's diffs (fixture/workspace.ts).

interface Point {
    readonly snapshot: Snapshot;
    /** The recording's `repo/path` keys pending at this point. */
    readonly pending: ReadonlySet<string>;
    readonly changes: readonly Change[];
}

/** One file that differs from the previous point, with the two sides the diff view draws. */
interface Change {
    readonly change: SnapshotChange;
    readonly diff: FileDiff;
}

// Each recording row's status, so a file a point brings back or takes away is named the way git named it.
const statusOf = (): Map<string, ChangeStatus> =>
    new Map(worktreeChanges().repos.flatMap((repo) => [...repo.staged, ...repo.unstaged].map((row) => [`${repo.repo}/${row.path}`, row.status] as const)));

const scopeAndPath = (key: string) => {
    const slash = key.indexOf(`/`);
    return { scope: key.slice(0, slash), path: key.slice(slash + 1) };
};

const reversed = (status: ChangeStatus): SnapshotChange[`status`] => (status === `added` ? `deleted` : `modified`);
const forward = (status: ChangeStatus): SnapshotChange[`status`] => (status === `added` || status === `deleted` || status === `type-changed` ? status : `modified`);

// What changed between two pending sets: a key that became pending is its recorded change, one that stopped being
// pending is that change undone.
const between = (before: ReadonlySet<string>, after: ReadonlySet<string>): Change[] => {
    const statuses = statusOf();
    const appeared = [...after].filter((key) => !before.has(key));
    const went = [...before].filter((key) => !after.has(key));
    const changeOf = (key: string, undone: boolean): Change => {
        const { scope, path } = scopeAndPath(key);
        const status = statuses.get(key) ?? `modified`;
        const sides = fileDiff(scope, path);
        const diff = sides.binary === true ? { binary: true } : undone ? sidesOf(sides.after, sides.before) : sides;
        return { change: { scope, path, status: undone ? reversed(status) : forward(status) }, diff };
    };
    return [...appeared.map((key) => changeOf(key, false)), ...went.map((key) => changeOf(key, true))];
};

const HOUR = 3_600_000;
const points: Point[] = [];
let counter = 0;

const pointId = (): string => {
    counter += 1;
    return checkpointId(counter);
};

const append = (trigger: SnapshotTrigger, at: number, pending: ReadonlySet<string>, label?: string): Point => {
    const previous = points.at(-1)?.pending ?? new Set<string>();
    const snapshot: Snapshot = { id: pointId(), at, trigger };
    if (label !== undefined) {
        snapshot.label = label;
    }
    const point = { snapshot, pending, changes: between(previous, pending) };
    points.push(point);
    return point;
};

// The recording's afternoon, oldest first: the owner's handover document arrives before the checkout turn starts, that
// turn's work is in place before the soft-delete turn starts, and the owner's own edits are saved after it. A desk or a
// fresh sandbox has its own short past.
const seed = (): void => {
    const keys = [...statusOf().keys()];
    const by = (...wanted: string[]): Set<string> => new Set(keys.filter((key) => wanted.some((prefix) => key.startsWith(prefix))));
    if (freshEdition) {
        return;
    }
    if (deskEdition) {
        append(`turn`, STARTED_AT - 4 * HOUR, new Set(), `Move the September newsletter into the new template`);
        append(`user`, STARTED_AT - HOUR, new Set(keys));
        return;
    }
    append(`turn`, STARTED_AT - 6 * HOUR, by(`web/docs/`), `Add Stripe checkout to the pricing page`);
    append(`turn`, STARTED_AT - 3 * HOUR, by(`web/docs/`, `web/src/`, `api/src/routes/`), `Soft-delete the users table`);
    append(`user`, STARTED_AT - 40 * 60_000, new Set(keys));
};

const timeline = (): Point[] => {
    if (points.length === 0) {
        seed();
    }
    return points;
};

const pointOf = (id: string): Point => timeline().find((point) => point.snapshot.id === id) ?? refuse(`unknown snapshot`, 404);

/** Takes a point of the tree as it stands now: before a git verb moves it, as the daemon's verbs do. */
export const checkpoint = (trigger: SnapshotTrigger, label?: string): void => {
    timeline();
    append(trigger, Date.now(), pendingKeys(), label);
};

export const snapshotList = (): SnapshotsList => ({ snapshots: timeline().map((point) => point.snapshot).toReversed() });

export const snapshotDiff = (id: string): SnapshotDiff => ({ changes: pointOf(id).changes.map((entry) => entry.change) });

/** One file's sides across a point; a file the point did not change reads the same on both. */
export const snapshotFileDiff = (id: string, scope: string, path: string): FileDiff => {
    const found = pointOf(id).changes.find((entry) => entry.change.scope === scope && entry.change.path === path);
    if (found !== undefined) {
        return found.diff;
    }
    const sides = fileDiff(scope, path);
    return sides.binary === true ? { binary: true } : { before: sides.after ?? ``, after: sides.after ?? `` };
};

/** Puts the tree back to a point: pre-restore point, the pending set as it stood, restore point; every window is told. */
export const restoreSnapshot = (id: string) => {
    const target = pointOf(id);
    checkpoint(`pre-restore`);
    const before = pendingKeys();
    restorePending(target.pending, new Set(statusOf().keys()));
    checkpoint(`restore`);
    const paths = [...new Set([...before, ...target.pending])];
    for (const listener of listeners) {
        listener({ kind: `workspaceChanged`, paths });
    }
    return { ok: true } as const;
};
