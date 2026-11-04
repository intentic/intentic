// THE ONE SHAPE OF "FIX WITH AGENT". A failure the app cannot settle by itself (a sync that conflicts, a push the remote
// turns away, a commit a hook refuses, a dev server that crashed, a build that failed) is described once, here, by the
// surface that shows it, and every surface offers the same press for it (FixWithAgent.vue, started by
// agentActions.startFix): the same model job (`workflow-fix`), the same brief, the same rules about whose tree the agent
// works in. A surface states what failed and what fixed looks like; it never writes the prompt.

// Where the agent works. `shared`: the owner's own checkout, for a fix whose subject IS that checkout: its git state (its
// commits, its index, its remote, a rebase left half done), or what runs from it (a dev server that crashed, a start
// refused); a copy would fix a branch nobody asked about, or a tree nothing runs from. Such a conversation proposes its
// plan before it touches anything, as every turn on the shared tree does. `own`: a worktree of its own, for a fix to a
// file, which lands as a reviewable diff like any other agent's work.
export type FixTree = `shared` | `own`;

export interface AgentFix {
    // What failed, as the surface titles it: "Sync failed in targowisko".
    readonly title: string;
    // The repository it happened in, by the id the routes take (`root` is the workspace's own); absent when it belongs to none.
    readonly repo?: string | undefined;
    // What was run, when the failure is a command's.
    readonly command?: string | undefined;
    // The tool's own reason, verbatim.
    readonly reason?: string | undefined;
    // What it printed, as much as the surface has; trimmed to its tail here.
    readonly output?: string | undefined;
    // Anything else the agent needs to start from: the conflicted files, the operation in progress, the log's path.
    readonly facts?: readonly string[] | undefined;
    // What fixed looks like, addressed to the agent.
    readonly goal: string;
    readonly tree: FixTree;
}

// The model job every Fix with agent press stands at (model-roles.ts).
export const FIX_ROLE = `workflow-fix`;

// A tail, not a head: a failure's cause is nearly always in its last lines, and a whole build log would crowd out the brief.
const OUTPUT_LINES = 80;
const OUTPUT_CHARS = 6000;
export const outputTail = (output: string): string => {
    const lines = output.trimEnd().split(`\n`);
    const tail = lines.slice(-OUTPUT_LINES).join(`\n`);
    return tail.length > OUTPUT_CHARS ? tail.slice(-OUTPUT_CHARS) : tail;
};

const fence = (text: string): string => {
    // A fence longer than any backtick run inside, so output quoting markdown cannot close it early.
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
    const ticks = `\``.repeat(longest + 1);
    return `${ticks}\n${text}\n${ticks}`;
};

const repoLine = (repo: string): string => (repo === `root` ? `Repository: the workspace's own repository (its root).` : `Repository: \`${repo}\``);

const TREE_RULES = {
    shared:
        `You are working in my own checkout, not a copy: its branch, commits and remote are the real ones. ` +
        `Never force-push, never reset or drop commits, and never discard uncommitted changes. ` +
        `If fixing it needs a decision only I can make (which side of a conflict wins, going around a rule the remote enforces), stop and ask me.`,
    own: `Work in your own copy and fix the cause, not the symptom. When you are done, say what was wrong and what you changed.`,
} as const satisfies Record<FixTree, string>;

/** The brief a Fix with agent press sends: what failed, the evidence as the app holds it, what fixed looks like, and the rules for whose tree it is. */
export const fixPrompt = (fix: AgentFix): string => {
    const output = fix.output === undefined ? `` : outputTail(fix.output);
    const reason = fix.reason?.trim() ?? ``;
    return [
        `${fix.title.replace(/[.:]\s*$/u, ``)}. Fix it.`,
        [
            ...(fix.repo === undefined ? [] : [repoLine(fix.repo)]),
            ...(fix.command === undefined || fix.command === `` ? [] : [`Command: \`${fix.command}\``]),
            ...(fix.facts ?? []).map((fact) => `- ${fact}`),
        ].join(`\n`),
        // The reason is often the output's own last line; said twice, it reads as two problems.
        reason === `` || output.includes(reason) ? `` : `What it said:\n${fence(reason)}`,
        output === `` ? `` : `What it printed (the end):\n${fence(output)}`,
        fix.goal,
        TREE_RULES[fix.tree],
    ]
        .filter((part) => part !== ``)
        .join(`\n\n`);
};

/** Several failures from one press (a sync over three repos, two refused), as the one fix they ask for. */
export const combinedFix = (title: string, fixes: readonly AgentFix[]): AgentFix | undefined => {
    if (fixes.length <= 1) {
        return fixes[0];
    }
    return {
        title,
        facts: fixes.map((fix) => `${fix.repo === undefined ? fix.title : `\`${fix.repo}\``}: ${fix.reason ?? fix.title}`),
        goal: [...new Set(fixes.map((fix) => fix.goal))].join(`\n\n`),
        // One fix on the owner's tree makes the whole run one; a copy cannot repair the checkout.
        tree: fixes.some((fix) => fix.tree === `shared`) ? `shared` : `own`,
    };
};
