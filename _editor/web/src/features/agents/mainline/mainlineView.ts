import type { MainlineLand, MainlineRouting, MainlineRoutingKind, MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { formatClock, formatDate, formatDayMonthTime } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// THE MAIN LINE AS ONE READOUT: which of the main tree's checks a reader hears about first, and in what words. Pure over
// the status the daemon serves (workspace.mainline); the status dock draws it, and a card's mark borrows its words for
// what became of a red run, so the rail, the board and the dock never name one decision two ways.

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

// WHAT THE STATUS BAR SAYS AT REST, every part a reader watches for at once rather than one headline standing for the
// rest: the check running now and whose work it measures, every red project, how many lands wait, and, only while none
// of those says anything, when main was last seen green. Undefined while no land was ever checked, so a sandbox that
// never landed anything carries no main line at all.
export interface MainlineSummary {
    readonly running: MainlineRunning | undefined;
    // Longest red first (redsOf).
    readonly reds: readonly MainlineRed[];
    readonly waiting: number;
    readonly greenAt: number | undefined;
}

export const mainlineSummary = (status: MainlineStatus | undefined): MainlineSummary | undefined => {
    if (status === undefined || status.projects.length === 0) {
        return undefined;
    }
    const project = status.projects.find((candidate) => candidate.running !== undefined);
    const running = project?.running === undefined ? undefined : { project: project.project, ...project.running };
    const reds = redsOf(status);
    const waiting = queuedLands(status).length;
    const lastAt = Math.max(0, ...status.projects.map((candidate) => candidate.last?.at ?? 0));
    const quiet = running === undefined && reds.length === 0 && waiting === 0;
    if (quiet && lastAt === 0) {
        return undefined;
    }
    return { running, reds, waiting, greenAt: quiet ? lastAt : undefined };
};

// The lands a red run's failures were laid at: the suspects when the sandbox named any (a suspect may have landed in an
// earlier run of the streak, so it keeps its id when this run holds no title for it), else every land the run covered.
export const blamedLands = (run: MainlineRun): { readonly conversationId: string; readonly title?: string }[] =>
    run.suspects === undefined || run.suspects.length === 0
        ? run.lands
        : run.suspects.map((conversationId) => run.lands.find((land) => land.conversationId === conversationId) ?? { conversationId });

// The terminal a project's check runs in: the daemon's verify panel (verifyPanelKey), as the terminal names its session.
export const verifySession = (project: string): string => `panel-${project === `` ? `root` : project.replaceAll(/[^a-zA-Z0-9_-]/g, `_`)}--verify`;

// The workspace root is a project with no folder, and "" names nothing a reader can see.
export const projectName = (project: string): string => (project === `` ? t(`agents.mainline.root`) : project);

// The wall-clock minute a streak began, with its day once it is not today's: "14:02", "Sep 24, 09:10".
export const sinceWhen = (at: number, now: number = Date.now()): string => (formatDate(at) === formatDate(now) ? formatClock(at) : formatDayMonthTime(at));

export interface RoutingMeta {
    readonly icon: IconName;
    // A clause, for the status bar beside a red and a card's hover.
    readonly words: string;
    // One or two words, for the rail card beside "Broke 2".
    readonly short: string | undefined;
}

// One entry per kind, so a kind the contract adds is a build error here rather than a blank on screen.
const routingTable = () =>
    ({
        waiting: { icon: `clock`, words: t(`agents.mainline.routingWaiting`), short: t(`agents.mainline.shortWaiting`) },
        held: { icon: `clock`, words: t(`agents.mainline.routingHeld`), short: t(`agents.mainline.shortHeld`) },
        original: { icon: `wrench`, words: t(`agents.mainline.routingOriginal`), short: t(`agents.mainline.shortOriginal`) },
        "fix-up": { icon: `wrench`, words: t(`agents.mainline.routingFixUp`), short: t(`agents.mainline.shortFixUp`) },
        reported: { icon: `info-circle`, words: t(`agents.mainline.routingReported`), short: t(`agents.mainline.shortReported`) },
        resolved: { icon: `check`, words: t(`agents.mainline.routingResolved`), short: t(`agents.mainline.shortResolved`) },
        spent: { icon: `exclamation-triangle`, words: t(`agents.mainline.routingSpent`), short: t(`agents.mainline.shortSpent`) },
    }) as const satisfies Record<MainlineRoutingKind, RoutingMeta>;

// Undecided reads as the sandbox still deciding, which it is until the lands queued behind the red have had their check.
// The `??` is for a newer daemon's kind this build has no words for: a clause about deciding beats a blank.
export const routingMeta = (kind: MainlineRoutingKind | undefined): RoutingMeta => {
    const deciding: RoutingMeta = { icon: `clock`, words: t(`agents.mainline.routingDeciding`), short: undefined };
    return kind === undefined ? deciding : (routingTable()[kind] ?? deciding);
};
