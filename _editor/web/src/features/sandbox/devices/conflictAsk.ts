import type { DeviceConflict } from "@intentic/sandbox-contract";
import { composeAsk } from "@intentic/sandbox-contract/chores";

/* WHAT TO SAY TO AN AGENT ABOUT A STUCK FOLDER, and why this is the button a conflict deserves.
 *
 * Resolving a file-sync conflict is per file and per judgement: somebody has to open both copies of
 * `settings.json`, work out that the laptop's is last week's and the sandbox's has the change they remember
 * making, and put one of them on both ends. Nothing about that is a switch, which is why the card offers no
 * "resolve" button and never should: a one-click winner is a one-click way to lose an afternoon's work on the
 * losing side. It IS, exactly, a turn: read both, decide, make them agree, say what you did.
 *
 * And an agent in this sandbox can reach both ends, which is the part that makes the offer honest rather than
 * decorative. The sandbox's copy is a file it can open; the device's copy is under that machine's own tools,
 * which exist because the same machine is a connected device (the `hostId` this ask requires is what the button
 * gates on). No new command on the machine, no new permission: the two things it needs are already there.
 *
 * The turn is aimed at the OWNER'S tree, not at a worktree, which is the one thing about this job that reads
 * wrong from inside an isolated conversation: /work is that conversation's own checkout, and the folder the
 * sync session actually carries is the shared one. Said explicitly in the prompt, because a turn that "fixed"
 * the conflicts inside its own worktree would change nothing at all and report success. */

// What happened on each side, named for the two places rather than for Mutagen's endpoints: the agent is on
// neither of them, so "alpha" and "here" are both wrong and the machine's own name is right.
const CHANGE: Record<NonNullable<DeviceConflict[`local`]>, string> = { created: `created`, modified: `changed`, deleted: `deleted` };

const sides = (conflict: DeviceConflict, machine: string): string => {
    const said = [
        conflict.local === undefined ? undefined : `${CHANGE[conflict.local]} on ${machine}`,
        conflict.sandbox === undefined ? undefined : `${CHANGE[conflict.sandbox]} in the sandbox`,
    ].filter((side) => side !== undefined);
    // Mutagen reported a conflict without saying what kind of change made it: the path is still the finding,
    // and inventing a verb for it would be the one thing this ask must not do.
    return said.length === 0 ? `both ends changed it` : said.join(`, `);
};

const pathLine = (conflict: DeviceConflict, machine: string): string =>
    `- ${conflict.path === `` ? `(the synced folder itself)` : conflict.path} — ${sides(conflict, machine)}`;

/* Every clause here has a failure behind it that this turn could plausibly produce:
 *   the worktree note        a turn that resolves conflicts inside its own checkout changes neither end,
 *   read before you write    the only irreversible move available is overwriting a side unread,
 *   the list is the scope    it is loose in somebody's home directory with write tools,
 *   ask rather than merge    "both sides carry real work" is the case a person must decide, not a model,
 *   leave the session alone  pausing or unpairing to "fix" it hides the conflicts instead of resolving them. */
const CONFLICT_INVARIANTS =
    `Both ends are real files somebody uses, and neither write goes through \`land\`, so nothing here is reviewable ` +
    `as a diff afterwards: touch only paths that are actually in conflict, and read both copies of a path before ` +
    `you write either. Where both sides hold work that matters, say so and ask rather than picking a winner. Do not pause, ` +
    `resume or unpair the sync, and do not touch Mutagen: the session resolves itself the moment the two ends agree.`;

export interface ConflictAsk {
    /** The button's tooltip: what the turn will do, before anyone spends one. */
    readonly hint: string;
    /** The turn, sent as an ordinary first message so it sits in the transcript to be steered. */
    readonly prompt: string;
}

export interface ConflictSubject {
    /** What the machine is called on screen, which is also what its owner calls it. */
    readonly machine: string;
    /** The host capability's id, which is the namespace of that machine's own tools (`mcp__<hostId>__…`). */
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
    // The remainder is stated rather than dropped: the report caps what it carries and Mutagen caps what it
    // reports, and a turn told about six of forty conflicts would declare victory forty percent of the way in.
    const rest = conflicts - listed.length;
    /* An agent older than the field reports the count and no paths, and that machine's own `status` is no help
     * either — it predates printing them too, so a turn sent to read it would come back with the number it
     * already has. Mutagen itself is the source underneath both, and asking it directly is a thing an agent on
     * that machine can do and this browser cannot. */
    const inventory =
        listed.length === 0
            ? `That machine's agent is too old to report which paths they are. Ask Mutagen on the machine itself: \`mutagen sync ` +
              `list\`, and read the conflicts of the session whose alpha is ${folder} (mutagen may not be on PATH — the agent keeps ` +
              `its own copy under its state directory).`
            : [
                  `The stuck paths, and what happened to each:`,
                  ``,
                  ...listed,
                  /* The remainder is a fact about the LIST, not about the job, and it needs somewhere to go:
                   * this machine's own `status` caps its output as well, so the pointer is at Mutagen, and at
                   * re-reading rather than at trusting one answer to be the whole of it. */
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
