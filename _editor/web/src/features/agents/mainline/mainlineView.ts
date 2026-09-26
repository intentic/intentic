import type {
    Finding,
    MainlineLand,
    MainlineLandRef,
    MainlinePush,
    MainlineRouting,
    MainlineRoutingKind,
    MainlineRun,
    MainlineStatus,
    Red,
} from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { formatClock, formatDate, formatDayMonthTime } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// THE MAIN LINE AS ONE READOUT: what the main tree's own check says, in the order and the words a reader takes it in.
// Pure over the status the daemon serves (workspace.mainline); the status bar draws it, and a card's mark borrows its
// words for what became of a red run, so the rail, the board and the dock never name one decision two ways.
//
// Two questions are kept apart everywhere it is drawn, because one sentence answering both is what made it unreadable:
// HEALTH (is main passing, and if not, who has it) and ACTIVITY (what the check is doing now, and what queues for it).

// A SANDBOX TOO OLD FOR THIS READOUT. Every current daemon sends `reds`, empty or not; one from before 2026-09-25 (every
// release up to v1.312) sends none, and lays no reds, names no check terminal and splits no failures either. Nothing here
// rebuilds those from its raw runs: the panel says the sandbox needs an update (SandboxOutdatedNotice.vue) and shows only
// what it did serve, as served. Read off the field, never the version: a sandbox built from a checkout says 0.0.0.
export const daemonOutdated = (status: MainlineStatus): boolean => status.reds === undefined;

// One project red right now: the run that says so, when its streak began, the work the sandbox laid it at, and the latest
// decision about it. All of it is the daemon's (MainlineProject.red), read, never re-derived.
export interface MainlineRed {
    readonly project: string;
    readonly run: MainlineRun;
    readonly since: number;
    // The work the red is laid at; empty when nobody could be.
    readonly cause: readonly MainlineLandRef[];
    // Whether the paths the lands changed narrowed `cause` to them; false when it is every land the run covered.
    readonly named: boolean;
    readonly fixer: MainlineRouting | undefined;
}

// Longest red first: the breakage that has waited longest is the one a reader is owed first.
export const redsOf = (status: MainlineStatus): MainlineRed[] =>
    status.projects
        .flatMap((project): MainlineRed[] => {
            if (project.last?.status !== `red`) {
                return [];
            }
            const red = project.red;
            return red === undefined
                ? []
                : [{ project: project.project, run: project.last, since: red.since, cause: red.cause, named: red.named, fixer: red.fixer }];
        })
        .toSorted((left, right) => left.since - right.since);

// Lands waiting for a check, each once: a land touching two projects waits in both queues.
export const queuedLands = (status: MainlineStatus): { readonly land: MainlineLand; readonly project: string }[] => {
    const seen = new Set<string>();
    return status.projects.flatMap((project) =>
        project.queued.flatMap((land) => {
            const key = `${land.conversationId}\n${land.at}`;
            if (seen.has(key)) {
                return [];
            }
            seen.add(key);
            return [{ land, project: project.project }];
        }),
    );
};

// The check running now: one at a time across the whole tree, so at most one project carries it.
export interface MainlineRunning {
    readonly project: string;
    readonly command: string;
    readonly startedAt: number;
    readonly lands: readonly MainlineLand[];
    // The runner the check was sent to (settings `offload.landCheck`); absent when it runs in this sandbox.
    readonly on?: string;
}

// WHAT A PUSH LEFT BEHIND, per project: what its push Red owes, and the pushes that brought it in. The pre-push hook
// never refuses, so this is the only place what it let through is still said after its terminal is gone. Nobody is sent
// after any of it (RED_POLICY: a push red waits for the owner), which is why nothing here is ever drawn as failing.
export interface PushDebt {
    readonly project: string;
    // The project's push red: what it owes, since when, and every decision about it.
    readonly red: Red;
    // The tree's own breakage first (a `code` gate fails whoever caused it), then by what measured it, in the daemon's
    // order within each.
    readonly open: readonly Finding[];
    // Newest first, only those that brought in something still owed.
    readonly pushes: readonly MainlinePush[];
    // Absent only when every push that brought it in has aged out of the record.
    readonly newest: MainlinePush | undefined;
}

// Absent from a daemon that records no pushes, which reads the same as one that recorded none.
const pushesOf = (status: MainlineStatus | undefined): readonly MainlinePush[] => status?.pushed ?? [];

// Every project's push red, from the one list of reds.
const pushRedsOf = (status: MainlineStatus | undefined): readonly Red[] => (status?.reds ?? []).filter((red) => red.source === `push`);

// What each project owes, by finding id.
const owedByProject = (status: MainlineStatus | undefined): ReadonlyMap<string, ReadonlySet<string>> =>
    new Map(pushRedsOf(status).map((red) => [red.scope, new Set(red.findings.map((finding) => finding.id))]));

// How much of what a push brought in its project still owes.
const stillOwed = (push: MainlinePush, owed: ReadonlyMap<string, ReadonlySet<string>>): number =>
    push.findings.filter((finding) => owed.get(push.project)?.has(finding.id) === true).length;

// A finding as a dock row can hold it. Checks print the path a finding is about whole from the repository root, and in a
// column sixteen rem wide that prefix is all a reader would see, the same five folders on every row. The row keeps the
// file (or, for a folder, its parent and itself), and the tooltip keeps the whole line. A check that reports through a
// bulleted list prints `- ` before each finding, which the row, already one item of a list, has no use for.
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

const findingOrder = (left: Finding, right: Finding): number =>
    Number(left.gate !== `code`) - Number(right.gate !== `code`) || left.source.localeCompare(right.source);

// Most owed first.
export const pushDebtOf = (status: MainlineStatus | undefined): PushDebt[] => {
    const owed = owedByProject(status);
    return pushRedsOf(status)
        .filter((red) => red.findings.length > 0)
        .map((red) => {
            const pushes = pushesOf(status).filter((push) => push.project === red.scope && stillOwed(push, owed) > 0);
            return { project: red.scope, red, open: red.findings.toSorted(findingOrder), pushes, newest: pushes[0] };
        })
        .toSorted((left, right) => right.open.length - left.open.length);
};

// WHAT THE STATUS BAR SAYS AT REST: health (every red, or passing once anything was checked), activity (the check
// running now, how many lands queue behind it), and what pushes left behind. What a push left is the owner's to pick up
// whenever they choose, so it never takes "passing" off the bar: the two are about different trees (the one landed on,
// and the one that left). Undefined while nothing was ever checked, run, queued or pushed, so a sandbox that never
// landed or pushed anything carries no main line at all.
export interface MainlineSummary {
    readonly running: MainlineRunning | undefined;
    // Longest red first (redsOf).
    readonly reds: readonly MainlineRed[];
    readonly queued: number;
    // Some project has a settled check, so "passing" is said about something that was measured.
    readonly checked: boolean;
    // What the push reds owe across every project (pushDebtOf).
    readonly leftAtPush: number;
    // The sandbox is too old to say who has a red or what a push left (daemonOutdated), so `reds` and `leftAtPush` are
    // empty for want of an answer, not because main is clean: the bar says so instead of "passing".
    readonly outdated: boolean;
}

export const mainlineSummary = (status: MainlineStatus | undefined): MainlineSummary | undefined => {
    if (status === undefined) {
        return undefined;
    }
    const leftAtPush = pushDebtOf(status).reduce((total, debt) => total + debt.open.length, 0);
    const project = status.projects.find((candidate) => candidate.running !== undefined);
    const running = project?.running === undefined ? undefined : { project: project.project, ...project.running };
    const reds = redsOf(status);
    const queued = queuedLands(status).length;
    const checked = status.projects.some((candidate) => candidate.last !== undefined);
    const outdated = daemonOutdated(status);
    // An older sandbox's pushes still count as something having happened: they are what its update would show.
    const pushedAny = pushesOf(status).length > 0;
    if (running === undefined && reds.length === 0 && queued === 0 && !checked && leftAtPush === 0 && !(outdated && pushedAny)) {
        return undefined;
    }
    return { running, reds, queued, checked, leftAtPush, outdated };
};

// THE RECORD, lands' checks and pushes' measurements in one list, newest first. A push reads as what it left: how many
// of its findings its project still owes, or that every one it had was since resolved or dismissed (`handled`), or clean.
export type MainlineEvent =
    | { readonly kind: `land`; readonly run: MainlineRun }
    | { readonly kind: `push`; readonly push: MainlinePush; readonly open: number; readonly handled: boolean };

const eventAt = (event: MainlineEvent): number => (event.kind === `land` ? event.run.at : event.push.at);

// An older sandbox's pushes are left out: with no reds, nothing says what of theirs is still owed, and "handled" would be
// a guess.
export const timelineOf = (status: MainlineStatus, limit: number): MainlineEvent[] => {
    const owed = owedByProject(status);
    return [
        ...status.recent.map((run): MainlineEvent => ({ kind: `land`, run })),
        ...(daemonOutdated(status) ? [] : pushesOf(status)).map((push): MainlineEvent => {
            const open = stillOwed(push, owed);
            return { kind: `push`, push, open, handled: open === 0 && push.findings.length > 0 };
        }),
    ]
        .toSorted((left, right) => eventAt(right) - eventAt(left))
        .slice(0, limit);
};

// What the pushes measured since `since` left owed: the review's "Pushed" note reads it for the push it just made. By
// time rather than by repository, since the daemon files a push under its project and the note is about one moment.
export const leftSince = (status: MainlineStatus | undefined, since: number): number => {
    const owed = owedByProject(status);
    return pushesOf(status)
        .filter((push) => push.at >= since)
        .reduce((total, push) => total + stillOwed(push, owed), 0);
};

// A pushed commit as git abbreviates it.
export const shortSha = (sha: string): string => sha.slice(0, 7);

// The branch the record's pushes go to, so a row names its branch only when it went somewhere else: the one most of them
// went to, and on a tie the one the newest went to. Read off the record rather than assumed to be `main`, since a
// repository's own main line can be called anything.
export const usualBranch = (status: MainlineStatus): string | undefined => {
    const counts = new Map<string, number>();
    for (const push of pushesOf(status)) {
        if (push.branch !== undefined) {
            counts.set(push.branch, (counts.get(push.branch) ?? 0) + 1);
        }
    }
    // Map keeps first insertion, which is the newest push's order, so a stable sort breaks a tie towards the newest.
    return [...counts].toSorted((left, right) => right[1] - left[1])[0]?.[0];
};

// One project's line in the panel's Result column: its last settled check, and the red streak when it is in one.
export interface MainlineResult {
    readonly project: string;
    readonly run: MainlineRun;
    readonly red: MainlineRed | undefined;
}

// Every project that has been checked, the reds first in the bar's order, then the rest in folder order.
export const resultsOf = (status: MainlineStatus): MainlineResult[] => {
    const reds = redsOf(status);
    const rest = status.projects.flatMap((project): MainlineResult[] =>
        project.last === undefined || reds.some((red) => red.project === project.project)
            ? []
            : [{ project: project.project, run: project.last, red: undefined }],
    );
    return [...reds.map((red) => ({ project: red.project, run: red.run, red })), ...rest];
};

// A failure as a reader scans it: a failing test by its name, with the file it sits in after, since a whole location
// would spend a narrow column on the path; anything else as the check printed it, which already names its path.
// The daemon splits every run that names failures (`units`).
export const failuresOf = (run: MainlineRun): { readonly name: string; readonly file?: string }[] =>
    (run.units ?? []).map((unit) => {
        const file = unit.path === undefined || unit.name.includes(unit.path) ? undefined : unit.path.split(`/`).at(-1);
        return { name: unit.name, ...(file === undefined || file === `` ? {} : { file }) };
    });

// The terminal a project's check runs in, as the daemon names it; undefined from a sandbox too old to name it.
export const checkSession = (status: MainlineStatus, project: string): string | undefined =>
    status.projects.find((candidate) => candidate.project === project)?.session;

// The workspace root is a project with no folder, and "" names nothing a reader can see.
export const projectName = (project: string): string => (project === `` ? t(`agents.mainline.root`) : project);

// The wall-clock minute a streak began, with its day once it is not today's: "14:02", "Sep 24, 09:10".
export const sinceWhen = (at: number, now: number = Date.now()): string => (formatDate(at) === formatDate(now) ? formatClock(at) : formatDayMonthTime(at));

// WHO HAS A RED, in the answers a reader acts on: somebody is fixing it, it waits on purpose, or it waits for you (and,
// in the record, a later check cleared it before anybody was sent). The daemon tells seven decisions apart; which road a
// fix took (back to the conversation that landed it, or a fresh one) changes nothing the reader does, so they share words.
export type FixState = `fixing` | `on-hold` | `needs-you` | `fixed`;

export interface RoutingMeta {
    readonly state: FixState;
    readonly icon: IconName;
    // The whole clause: the panel's line under a red, a card's hover.
    readonly words: string;
    // One or two words: beside a red in the status bar, beside "Broke 2" on a card. Undefined while still deciding.
    readonly short: string | undefined;
    // The clause a conversation's title follows in the panel, for a decision that names one: "Being fixed in …".
    readonly lead: string | undefined;
}

// One entry per kind, so a kind the contract adds is a build error here rather than a blank on screen.
const routingTable = () => {
    const fixing: RoutingMeta = {
        state: `fixing`,
        icon: `wrench`,
        words: t(`agents.mainline.routingFixing`),
        short: t(`agents.mainline.shortFixing`),
        lead: t(`agents.mainline.leadFixing`),
    };
    const onHold = t(`agents.mainline.shortOnHold`);
    const needsYou = t(`agents.mainline.shortNeedsYou`);
    return {
        waiting: { state: `on-hold`, icon: `pause`, words: t(`agents.mainline.routingWaiting`), short: onHold, lead: undefined },
        held: { state: `on-hold`, icon: `pause`, words: t(`agents.mainline.routingHeld`), short: onHold, lead: t(`agents.mainline.leadHeld`) },
        original: fixing,
        "fix-up": fixing,
        reported: { state: `needs-you`, icon: `exclamation-triangle`, words: t(`agents.mainline.routingReported`), short: needsYou, lead: undefined },
        resolved: {
            state: `fixed`,
            icon: `check`,
            words: t(`agents.mainline.routingResolved`),
            short: t(`agents.mainline.shortFixed`),
            lead: undefined,
        },
        spent: { state: `needs-you`, icon: `exclamation-triangle`, words: t(`agents.mainline.routingSpent`), short: needsYou, lead: undefined },
        // Only a push red's findings are dismissed, by the owner, so it is settled rather than fixed.
        dismissed: {
            state: `fixed`,
            icon: `eye-slash`,
            words: t(`agents.mainline.routingDismissed`),
            short: t(`agents.mainline.shortDismissed`),
            lead: undefined,
        },
    } as const satisfies Record<MainlineRoutingKind, RoutingMeta>;
};

// Undecided reads as the sandbox still deciding, which it is until the lands queued behind the red have had their check.
// The `??` is for a newer daemon's kind this build has no words for: a clause about deciding beats a blank.
export const routingMeta = (kind: MainlineRoutingKind | undefined): RoutingMeta => {
    const deciding: RoutingMeta = { state: `on-hold`, icon: `clock`, words: t(`agents.mainline.routingDeciding`), short: undefined, lead: undefined };
    return kind === undefined ? deciding : (routingTable()[kind] ?? deciding);
};

// What a card calls a land that broke main: how many failures its run named, then who has them once the sandbox has
// decided. The board's red line and the rail's seal both say it, in these same words.
export const brokeLabel = (failures: number, routing: MainlineRoutingKind | undefined): string => {
    const broke = failures > 0 ? t(`agents.landCheck.broke`, { count: failures }) : t(`agents.landCheck.brokeMain`);
    const short = routingMeta(routing).short;
    return routing === undefined || short === undefined ? broke : `${broke} · ${short}`;
};

// The ink a decision is said in: only one that waits for the reader asks for their eye.
export const fixTone = (state: FixState): string => (state === `needs-you` ? `text-warning` : state === `fixed` ? `text-success` : `text-muted`);
