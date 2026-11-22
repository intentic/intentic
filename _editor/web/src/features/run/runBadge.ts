import type { ViewBadge } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { type RunLane, runningCount } from "./runLanes";

// THE RUN TILE'S BADGE on the rail, read off the same lanes the Run view draws (runLanes.ts), so the tile and the page
// it opens never disagree. Pure: lanes in, badge out.
//   - A program that stopped with an error on a computer is the one thing owed: its count in danger, like a failing
//     run on any other tile.
//   - Otherwise what runs is an inventory, nothing owed: its count, neutral.
//   - A build, push or launch still going is work in flight: the tile's turning mark, whichever count it wears.
export const runBadgeOf = (lanes: readonly RunLane[]): ViewBadge | undefined => {
    const items = lanes.flatMap((lane) => lane.active);
    const failed = items.filter((item) => item.state === `failed`).length;
    const starting = items.filter((item) => item.state === `starting`).length;
    const up = runningCount(lanes);
    const running = up > 0 ? t(`run.view.runningCount`, { count: up }, up) : undefined;
    const flight: Pick<ViewBadge, `running`> = starting > 0 ? { running: t(`run.badge.starting`, { count: starting }, starting) } : {};
    if (failed > 0) {
        const fell = t(`run.badge.failed`, { count: failed }, failed);
        return { count: failed, tone: `danger`, tooltip: running === undefined ? fell : `${fell} · ${running}`, ...flight };
    }
    if (up > 0) {
        return { count: up, tone: `neutral`, tooltip: running, ...flight };
    }
    return starting > 0 ? flight : undefined;
};
