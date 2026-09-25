import type {
    MainlineLand,
    MainlineLandRef,
    MainlinePush,
    MainlineRouting,
    MainlineRoutingKind,
    MainlineRun,
    MainlineStatus,
    PushFinding,
    PushFindingKind,
} from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { formatClock, formatDate, formatDayMonthTime } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// THE MAIN LINE AS ONE READOUT: what the main tree's own check says, in the order and the words a reader takes it in.
// Pure over the status the daemon serves (workspace.mainline); the status dock draws it, and a card's mark borrows its
// words for what became of a red run, so the rail, the board and the dock never name one decision two ways.
//
// Two questions are kept apart everywhere it is drawn, because one sentence answering both is what made it unreadable:
// HEALTH (is main passing, and if not, who has it) and ACTIVITY (what the check is doing now, and what queues for it).

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
            const red = project.red ?? legacyRed(status, project);
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

// WHAT A PUSH LEFT BEHIND, per project: every finding still open, once each, and the pushes that brought them. The
// pre-push hook never refuses, so this is the only place what it let through is still said after its terminal is gone.
// Nobody is sent after any of it; it waits for the owner, which is why nothing here is ever drawn as failing.
export interface PushDebt {
    readonly project: string;
    // The tree's own breakage first (a `code` gate fails whoever caused it), then by what measured it, in the daemon's
    // order within each.
    readonly open: readonly PushFinding[];
    // Newest first, only those still holding an open finding.
    readonly pushes: readonly MainlinePush[];
    readonly newest: MainlinePush;
}

const isOpen = (finding: PushFinding): boolean => finding.state === `open`;

// Absent from a daemon that records no pushes, which reads the same as one that recorded none.
const pushesOf = (status: MainlineStatus | undefined): readonly MainlinePush[] => status?.pushes ?? [];

// A check's own id names it; the other four measure one thing each, so their kind is their name.
export const findingSource = (finding: PushFinding): string => finding.check ?? finding.kind;

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

// Only a check's or the linter's finding can be measured again; the other three are about the pushed commits
// themselves (contract, PushFindingKindSchema), so they end only when somebody dismisses them.
const RECHECKABLE: ReadonlySet<PushFindingKind> = new Set([`check`, `lint`]);
export const recheckable = (finding: PushFinding): boolean => RECHECKABLE.has(finding.kind);

const findingOrder = (left: PushFinding, right: PushFinding): number =>
    Number(left.gate !== `code`) - Number(right.gate !== `code`) || findingSource(left).localeCompare(findingSource(right));

// Most left behind first. The same problem found by two pushes is one finding (its id is stable across pushes), and
// the newer push's copy speaks for it, since that is the measurement that last printed it.
export const pushDebtOf = (status: MainlineStatus | undefined): PushDebt[] => {
    const byProject = new Map<string, { open: Map<string, PushFinding>; pushes: MainlinePush[] }>();
    for (const push of pushesOf(status)) {
        const standing = push.findings.filter(isOpen);
        if (standing.length === 0) {
            continue;
        }
        const entry = byProject.get(push.project) ?? { open: new Map<string, PushFinding>(), pushes: [] };
        byProject.set(push.project, entry);
        entry.pushes.push(push);
        for (const finding of standing) {
            if (!entry.open.has(finding.id)) {
                entry.open.set(finding.id, finding);
            }
        }
    }
    return [...byProject]
        .map(([project, { open, pushes }]) => ({ project, open: [...open.values()].toSorted(findingOrder), pushes, newest: pushes[0]! }))
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
    // Open push findings across every project, each once (pushDebtOf).
    readonly leftAtPush: number;
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
    if (running === undefined && reds.length === 0 && queued === 0 && !checked && leftAtPush === 0) {
        return undefined;
    }
    return { running, reds, queued, checked, leftAtPush };
};

// THE RECORD, lands' checks and pushes' measurements in one list, newest first. A push reads as what it left: how many
// findings still stand, or that every one it had was since resolved or dismissed (`handled`), or clean.
export type MainlineEvent =
    | { readonly kind: `land`; readonly run: MainlineRun }
    | { readonly kind: `push`; readonly push: MainlinePush; readonly open: number; readonly handled: boolean };

const eventAt = (event: MainlineEvent): number => (event.kind === `land` ? event.run.at : event.push.at);

export const timelineOf = (status: MainlineStatus, limit: number): MainlineEvent[] =>
    [
        ...status.recent.map((run): MainlineEvent => ({ kind: `land`, run })),
        ...pushesOf(status).map((push): MainlineEvent => {
            const open = push.findings.filter(isOpen).length;
            return { kind: `push`, push, open, handled: open === 0 && push.findings.length > 0 };
        }),
    ]
        .toSorted((left, right) => eventAt(right) - eventAt(left))
        .slice(0, limit);

// What the pushes measured since `since` left open: the review's "Pushed" note reads it for the push it just made. By
// time rather than by repository, since the daemon files a push under its project and the note is about one moment.
export const leftSince = (status: MainlineStatus | undefined, since: number): number =>
    pushesOf(status)
        .filter((push) => push.at >= since)
        .reduce((total, push) => total + push.findings.filter(isOpen).length, 0);

// A pushed commit as git abbreviates it.
export const shortSha = (sha: string): string => sha.slice(0, 7);

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
export const failuresOf = (run: MainlineRun): { readonly name: string; readonly file?: string }[] =>
    run.units === undefined
        ? run.failures.map(legacyFailureParts)
        : run.units.map((unit) => {
              const file = unit.path === undefined || unit.name.includes(unit.path) ? undefined : unit.path.split(`/`).at(-1);
              return { name: unit.name, ...(file === undefined || file === `` ? {} : { file }) };
          });

// The terminal a project's check runs in, as the daemon names it.
export const checkSession = (status: MainlineStatus, project: string): string =>
    status.projects.find((candidate) => candidate.project === project)?.session ?? legacyVerifySession(project);

/* FALLBACK FOR DAEMONS BEFORE 2026-09-25, which serve no `red`, `session`, `named` or `units` ("one editor, many daemons",
   docs/architecture/app-plane.md). Each rebuilds from the raw runs what a newer daemon serves; nothing else reads them,
   and they go when no supported daemon lacks the fields. */

// The latest decision filed on the streak's runs.
const legacyRouting = (recent: readonly MainlineRun[], project: string, since: number): MainlineRouting | undefined =>
    recent.find((run) => run.project === project && run.status === `red` && run.at >= since && run.routing !== undefined)?.routing;

// The suspects named on any run of the streak, else the lands of the run that turned the project red.
const legacyRed = (
    status: MainlineStatus,
    project: MainlineStatus[`projects`][number],
): { readonly since: number; readonly cause: readonly MainlineLandRef[]; readonly named: boolean; readonly fixer: MainlineRouting | undefined } | undefined => {
    const since = project.redSince;
    if (since === undefined) {
        return undefined;
    }
    const streak = status.recent.filter((run) => run.project === project.project && run.status === `red` && run.at >= since);
    const named = streak.find((run) => run.suspects !== undefined && run.suspects.length > 0);
    const first = streak.at(-1);
    const cause =
        named?.suspects?.map((conversationId) => named.lands.find((land) => land.conversationId === conversationId) ?? { conversationId }) ??
        (first === undefined || first.attempt > 1 ? [] : first.lands);
    return { since, cause, named: named !== undefined, fixer: legacyRouting(status.recent, project.project, since) };
};

const legacyFailureParts = (failure: string): { readonly name: string; readonly file?: string } => {
    const cut = failure.indexOf(` › `);
    if (cut === -1) {
        return { name: failure };
    }
    const file = failure.slice(0, cut).trim().split(/[\s/]/).at(-1) ?? ``;
    const name = failure.slice(cut + ` › `.length).trim();
    return name === `` ? { name: failure } : { name, ...(file === `` ? {} : { file }) };
};

const legacyVerifySession = (project: string): string => `panel-${project === `` ? `root` : project.replaceAll(/[^a-zA-Z0-9_-]/g, `_`)}--verify`;

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
