import type { MainlineLand, MainlineRouting, MainlineRoutingKind, MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { formatClock, formatDate, formatDayMonthTime } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// THE MAIN LINE AS ONE READOUT: what the main tree's own check says, in the order and the words a reader takes it in.
// Pure over the status the daemon serves (workspace.mainline); the status dock draws it, and a card's mark borrows its
// words for what became of a red run, so the rail, the board and the dock never name one decision two ways.
//
// Two questions are kept apart everywhere it is drawn, because one sentence answering both is what made it unreadable:
// HEALTH (is main passing, and if not, who has it) and ACTIVITY (what the check is doing now, and what queues for it).

// One project red right now: the run that says so, when its streak began, and the latest decision about it.
export interface MainlineRed {
    readonly project: string;
    readonly run: MainlineRun;
    readonly since: number;
    readonly routing: MainlineRouting | undefined;
}

// The decision a red streak last got. It is filed on the runs it answered, and a later red in the same streak with nothing
// new in it gets none of its own, so the streak's newest run is not always the one carrying it.
const routingOf = (recent: readonly MainlineRun[], project: string, since: number): MainlineRouting | undefined =>
    recent.find((run) => run.project === project && run.status === `red` && run.at >= since && run.routing !== undefined)?.routing;

// Longest red first: the breakage that has waited longest is the one a reader is owed first.
export const redsOf = (status: MainlineStatus): MainlineRed[] =>
    status.projects
        .flatMap((project): MainlineRed[] =>
            project.redSince === undefined || project.last?.status !== `red`
                ? []
                : [{ project: project.project, run: project.last, since: project.redSince, routing: routingOf(status.recent, project.project, project.redSince) }],
        )
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
}

// WHAT THE STATUS BAR SAYS AT REST: health (every red, or passing once anything was checked) and activity (the check
// running now, how many lands queue behind it). Undefined while nothing was ever checked, run or queued, so a sandbox
// that never landed anything carries no main line at all.
export interface MainlineSummary {
    readonly running: MainlineRunning | undefined;
    // Longest red first (redsOf).
    readonly reds: readonly MainlineRed[];
    readonly queued: number;
    // Some project has a settled check, so "passing" is said about something that was measured.
    readonly checked: boolean;
}

export const mainlineSummary = (status: MainlineStatus | undefined): MainlineSummary | undefined => {
    if (status === undefined || status.projects.length === 0) {
        return undefined;
    }
    const project = status.projects.find((candidate) => candidate.running !== undefined);
    const running = project?.running === undefined ? undefined : { project: project.project, ...project.running };
    const reds = redsOf(status);
    const queued = queuedLands(status).length;
    const checked = status.projects.some((candidate) => candidate.last !== undefined);
    if (running === undefined && reds.length === 0 && queued === 0 && !checked) {
        return undefined;
    }
    return { running, reds, queued, checked };
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

// The lands a red run's failures were laid at: the suspects when the sandbox named any (a suspect may have landed in an
// earlier run of the streak, so it keeps its id when this run holds no title for it), else every land the run covered.
export const blamedLands = (run: MainlineRun): { readonly conversationId: string; readonly title?: string }[] =>
    run.suspects === undefined || run.suspects.length === 0
        ? run.lands
        : run.suspects.map((conversationId) => run.lands.find((land) => land.conversationId === conversationId) ?? { conversationId });

// The work a red streak is laid at: the suspects the sandbox named on any run of the streak, newest first, else the lands
// of the run that turned the project red. A later red run with nobody named only found main red, since nothing new
// failed in it, so its lands are never offered as the cause; nor is anything when the record no longer reaches back to
// the streak's first run.
export const causeOf = (status: MainlineStatus, red: MainlineRed): { readonly conversationId: string; readonly title?: string }[] => {
    const streak = status.recent.filter((run) => run.project === red.project && run.status === `red` && run.at >= red.since);
    const named = streak.find((run) => run.suspects !== undefined && run.suspects.length > 0);
    if (named !== undefined) {
        return blamedLands(named);
    }
    const first = streak.at(-1);
    return first === undefined || first.attempt > 1 ? [] : first.lands;
};

// A failure as a reader scans it: a failing test by its name first and its file after, since a test's full location
// ("@acme/web#test web/src/pages/changelog.test.ts › lists every release") would spend a narrow column on the path and cut
// the name. Anything that is not a test (a type error, a whole failed task) is kept whole.
export const failureParts = (failure: string): { readonly name: string; readonly file?: string } => {
    const cut = failure.indexOf(` › `);
    if (cut === -1) {
        return { name: failure };
    }
    // The location's last word past its last slash: "@acme/web#test web/src/pages/changelog.test.ts" is "changelog.test.ts".
    const file = failure.slice(0, cut).trim().split(/[\s/]/).at(-1) ?? ``;
    const name = failure.slice(cut + ` › `.length).trim();
    return name === `` ? { name: failure } : { name, ...(file === `` ? {} : { file }) };
};

// The terminal a project's check runs in: the daemon's verify panel (verifyPanelKey), as the terminal names its session.
export const verifySession = (project: string): string => `panel-${project === `` ? `root` : project.replaceAll(/[^a-zA-Z0-9_-]/g, `_`)}--verify`;

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

// The ink a decision is said in: only one that waits for the reader asks for their eye.
export const fixTone = (state: FixState): string => (state === `needs-you` ? `text-warning` : state === `fixed` ? `text-success` : `text-muted`);
