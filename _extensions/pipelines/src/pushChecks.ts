import {
    type AgentSummary,
    type Finding,
    type FixStance,
    fixStance,
    latestFixAttempt,
    type PushCheck,
    type PushChecks,
    pushFixBase,
    type Red,
} from "@intentic/sandbox-contract";

// WHAT A PUSH LEFT BEHIND, read off `workspace.pushChecks`: per project, what its push Red still owes, and the pushes the
// hook measured on the way out. The hook never refuses a push, so this board is the only place what it let through is
// still said once its terminal is gone. Nobody is sent after any of it unless the owner presses, which is why nothing
// here is ever drawn as failing. Pure, so the section, the rail badge and the tests read one projection.

export interface PushDebt {
    // The folder the push was measured in, relative to the workspace; empty is the workspace root.
    readonly project: string;
    // The project's push red: what it owes, since when, and every decision about it (the hand-over's id comes from it).
    readonly red: Red;
    // The tree's own breakage first (a `code` gate fails whoever caused it), then by what measured it, in the daemon's
    // order within each.
    readonly open: readonly Finding[];
    // Newest first, only those that brought in something still owed.
    readonly pushes: readonly PushCheck[];
    // Absent only when every push that brought it in has aged out of the record.
    readonly newest: PushCheck | undefined;
}

// A land's or CI's red is not a push's: only the push reds say what the hook let through.
const pushRedsOf = (checks: PushChecks | undefined): readonly Red[] => (checks?.reds ?? []).filter((red) => red.source === `push`);

// What each project owes, by finding id.
const owedByProject = (checks: PushChecks | undefined): ReadonlyMap<string, ReadonlySet<string>> =>
    new Map(pushRedsOf(checks).map((red) => [red.scope, new Set(red.findings.map((finding) => finding.id))]));

// How much of what a push brought in its project still owes.
const stillOwed = (push: PushCheck, owed: ReadonlyMap<string, ReadonlySet<string>>): number =>
    push.findings.filter((finding) => owed.get(push.project)?.has(finding.id) === true).length;

const findingOrder = (left: Finding, right: Finding): number =>
    Number(left.gate !== `code`) - Number(right.gate !== `code`) || left.source.localeCompare(right.source);

// Most owed first; a tie keeps the order the daemon lists the reds in.
export const pushDebtOf = (checks: PushChecks | undefined): PushDebt[] => {
    const owed = owedByProject(checks);
    return pushRedsOf(checks)
        .filter((red) => red.findings.length > 0)
        .map((red) => {
            const pushes = (checks?.pushed ?? []).filter((push) => push.project === red.scope && stillOwed(push, owed) > 0);
            return { project: red.scope, red, open: red.findings.toSorted(findingOrder), pushes, newest: pushes[0] };
        })
        .toSorted((left, right) => right.open.length - left.open.length);
};

// Everything the push reds owe, across every project: the rail's quieter count.
export const owedFindings = (debts: readonly PushDebt[]): number => debts.reduce((total, debt) => total + debt.open.length, 0);

// THE HAND-OVER'S LIVE ATTEMPT, as the fleet reports it. Its id is derived from when the red began (contract,
// pushFixBase), so the board and the daemon agree on whether an agent is already on it without a record of their own:
// the newest attempt at that base speaks, since starting a later one set every earlier one aside. A landed one answered
// findings that a later measurement will settle, so the row offers a fresh press rather than a chip about work
// already in the tree.
export interface PushFixAttempt {
    readonly agent: AgentSummary;
    readonly attempt: number;
    readonly stance: FixStance;
}

export const pushFixAttemptOf = (red: Red, agents: readonly AgentSummary[]): PushFixAttempt | undefined => {
    const base = pushFixBase(red);
    const latest = base === undefined ? undefined : latestFixAttempt(base, agents);
    if (latest === undefined) {
        return undefined;
    }
    const stance = fixStance(latest.agent);
    return stance.kind === `landed` ? undefined : { agent: latest.agent, attempt: latest.attempt, stance };
};

// THE PUSH RECORD, newest first: each push the hook measured, read as what it left. How many of its findings its project
// still owes, or that every one it had was since resolved or dismissed (`handled`), or none at all. A refused push never
// reached the remote; what the repository's own hook said is its one finding, owed like any other.
export interface PushRecord {
    readonly push: PushCheck;
    readonly open: number;
    readonly handled: boolean;
    readonly refused: boolean;
}

export const pushRecordOf = (checks: PushChecks | undefined): PushRecord[] => {
    const owed = owedByProject(checks);
    return (checks?.pushed ?? []).map((push) => {
        const open = stillOwed(push, owed);
        return { push, open, handled: open === 0 && push.findings.length > 0, refused: push.refused === true };
    });
};

// A finding as a row can hold it. Checks print the path a finding is about whole from the repository root, and in a
// narrow row that prefix is all a reader would see, the same five folders on every line. The row keeps the file (or,
// for a folder, its parent and itself), and the tooltip keeps the whole line. A check that reports through a bulleted
// list prints `- ` before each finding, which the row, already one item of a list, has no use for.
export const findingGist = (line: string): string => {
    const text = line.replace(/^-\s+/, ``);
    const path = /^[^\s:]+/.exec(text)?.[0] ?? ``;
    const segments = path.split(`/`).filter((segment) => segment !== ``);
    if (segments.length < 2) {
        return text;
    }
    const last = segments.at(-1)!;
    const kept = last.includes(`.`) ? last : segments.slice(-2).join(`/`);
    return `${kept}${text.slice(path.length)}`;
};

// A pushed commit as git abbreviates it.
export const shortSha = (sha: string): string => sha.slice(0, 7);

// A push by its commit and the branch it went to (even main: a feature branch leaving something is a different story).
export const pushTitle = (push: PushCheck): string => (push.branch === undefined ? shortSha(push.head) : `${shortSha(push.head)} → ${push.branch}`);

// The project a CI repository's pushes are filed under: CI names the workspace repository itself `root`, a push names it
// by its folder, which is empty.
export const pushProjectOf = (ciRepo: string): string => (ciRepo === `root` ? `` : ciRepo);
