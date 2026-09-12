import type { DeviceConflict } from "@intentic/sandbox-contract";
import { composeAsk } from "@intentic/sandbox-contract/chores";

// Builds the turn prompt for resolving a stuck file-sync conflict: per-file judgement a switch cannot make,
// offered because an agent here can reach both ends (the sandbox's copy directly, the device's through its own
// tools). Aimed at the owner's shared tree, not an isolated worktree.

// Named for the two places rather than Mutagen's endpoints, since the agent is on neither of them.
const CHANGE: Record<NonNullable<DeviceConflict[`local`]>, string> = { created: `created`, modified: `changed`, deleted: `deleted` };

const sides = (conflict: DeviceConflict, machine: string): string => {
    const said = [
        conflict.local === undefined ? undefined : `${CHANGE[conflict.local]} on ${machine}`,
        conflict.sandbox === undefined ? undefined : `${CHANGE[conflict.sandbox]} in the sandbox`,
    ].filter((side) => side !== undefined);
    // Mutagen reported a conflict without a change kind; the path is still the finding.
    return said.length === 0 ? `both ends changed it` : said.join(`, `);
};

const pathLine = (conflict: DeviceConflict, machine: string): string =>
    `- ${conflict.path === `` ? `(the synced folder itself)` : conflict.path} — ${sides(conflict, machine)}`;

// Each clause guards a failure this turn could produce:
// - worktree note: resolving inside the wrong checkout changes neither end
// - read before write: overwriting a side unread is the only irreversible move
// - the list is the scope: it has write tools loose in someone's home directory
// - ask rather than merge: two sides both holding real work is a human call
// - leave the session alone: pausing or unpairing hides the conflict instead of ending it
const CONFLICT_INVARIANTS =
    `Both ends are real files somebody uses, and neither write goes through \`land\`, so nothing here is reviewable ` +
    `as a diff afterwards: touch only paths that are actually in conflict, and read both copies of a path before ` +
    `you write either. Where both sides hold work that matters, say so and ask rather than picking a winner. Do not pause, ` +
    `resume or unpair the sync, and do not touch Mutagen: the session resolves itself the moment the two ends agree.`;

export interface ConflictAsk {
    /** The button's tooltip: what the turn will do, before spending one. */
    readonly hint: string;
    /** The turn, sent as an ordinary first message so it's steerable in the transcript. */
    readonly prompt: string;
}

export interface ConflictSubject {
    /** What the machine is called on screen and to its owner. */
    readonly machine: string;
    /** Host capability id: the namespace of that machine's own tools (`mcp__<hostId>__…`). */
    readonly hostId: string;
    /** The folder on that machine this sandbox is synced with. */
    readonly localDir: string | undefined;
    /** Mutagen's total, which can exceed the paths the report carries. */
    readonly conflicts: number;
    readonly conflictedPaths: readonly DeviceConflict[];
}

export const conflictAsk = ({ machine, hostId, localDir, conflicts, conflictedPaths }: ConflictSubject): ConflictAsk => {
    const folder = localDir ?? `the folder it syncs`;
    const listed = conflictedPaths.map((conflict) => pathLine(conflict, machine));
    // Stated rather than dropped: both the report and Mutagen cap what they carry.
    const rest = conflicts - listed.length;
    // An old agent reports the count with no paths, and its own `status` predates printing them too; Mutagen
    // itself is the source under both, reachable only by a turn running on that machine.
    const inventory =
        listed.length === 0
            ? `That machine's agent is too old to report which paths they are. Ask Mutagen on the machine itself: \`mutagen sync ` +
              `list\`, and read the conflicts of the session whose alpha is ${folder} (mutagen may not be on PATH — the agent keeps ` +
              `its own copy under its state directory).`
            : [
                  `The stuck paths, and what happened to each:`,
                  ``,
                  ...listed,
                  // A fact about the list's own cap, not the job; points at re-reading rather than trusting one answer.
                  ...(rest > 0
                      ? [
                            ``,
                            `…and ${rest} more that did not fit the report: \`mutagen sync list\` on that machine shows the session's own ` +
                                `list, and is worth re-reading after each batch, since neither list is promised to be complete.`,
                        ]
                      : []),
              ].join(`\n`);
    return {
        hint: `Start an agent on it: it reads both copies of each stuck file and makes the two ends agree.`,
        prompt: composeAsk({
            subject: `Resolve the ${conflicts === 1 ? `file-sync conflict` : `${conflicts} file-sync conflicts`} between this sandbox and "${machine}", the owner's own computer.`,
            why:
                `${folder} on ${machine} is two-way synced with this sandbox's workspace root. Both ends changed these paths since ` +
                `they last agreed, so the session held them rather than overwriting either copy: nothing is lost, and nothing at ` +
                `those paths moves in either direction until the two ends match again.`,
            diagnosis:
                `The sync mode is two-way-SAFE, which is why there is nothing mechanical to run: it flags a collision rather than ` +
                `picking a side, so one of the two copies has to be chosen, per path, by someone who has read both.`,
            goal:
                `${inventory}\n\n` +
                `For each path: read the copy on ${machine} (its tools are deferred — \`ToolSearch\` with \`+mcp__${hostId}__\`, then ` +
                `\`mcp__${hostId}__describe\` once before anything else) and the copy in the sandbox, then make the two agree — the ` +
                `same bytes on both ends, or gone from both if that is the answer. The sandbox's end is the OWNER'S workspace root, ` +
                `not yours: an isolated turn's /work is its own worktree, and the tree this folder is synced with is mounted at ` +
                `/mnt/intentic-main. Check which one you are in before you edit anything.`,
            invariants: CONFLICT_INVARIANTS,
            done:
                `Done when every path on that list holds the same content on both ends (or is gone from both), and you have said per ` +
                `path which copy won and why. The count on the Devices tab clears itself within a poll of the two ends agreeing.`,
        }),
    };
};
