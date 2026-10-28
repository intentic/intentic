import type { Tip, TipRow } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { PreviewTarget } from "../../models/preview/previewModel";

// What Start says before it is pressed, since a bare "Start" names neither the target nor the command it is about to
// run: the terminal its output lands in, what it runs, and what that costs, read off the tree rather than assumed (an
// install first for a Node run without node_modules, a first build for a Cargo run without target/). Undefined for a
// target with nothing to start.

// `panel-<repo>` / `panel-<repo>--<app>`, the process manager's own session names.
const startSessionOf = (target: PreviewTarget): string | undefined => {
    if (target.repo === undefined || !target.startable) {
        return undefined;
    }
    return target.app === undefined ? `panel-${target.repo}` : `panel-${target.repo}--${target.app}`;
};

const startCost = (target: PreviewTarget): string => {
    if (target.builds) {
        return target.installed ? t(`preview.previewPanel.startCostBuilt`) : t(`preview.previewPanel.startCostBuild`);
    }
    return target.installed ? t(`preview.previewPanel.startCostInstalled`) : t(`preview.previewPanel.startCostInstall`);
};

// The not-running screen's sentence.
export const startHintOf = (target: PreviewTarget): string | undefined => {
    const session = startSessionOf(target);
    if (session === undefined) {
        return undefined;
    }
    const what =
        target.app !== undefined
            ? t(`preview.previewPanel.appDevServer`, { app: target.app })
            : target.runs !== undefined
              ? t(`preview.previewPanel.repoRuns`, { command: target.runs, repo: target.repo ?? `` })
              : t(`preview.previewPanel.repoDevServer`, { repo: target.repo ?? `` });
    return t(`preview.previewPanel.startHint`, { what, session, cost: startCost(target) });
};

// The cost as the tip's row: a build is said as one, never as an install.
const costRow = (target: PreviewTarget): TipRow => {
    if (target.builds) {
        return target.installed
            ? { label: t(`preview.previewPanel.build`), value: t(`preview.previewPanel.built`) }
            : { label: t(`preview.previewPanel.build`), value: t(`preview.previewPanel.buildFirst`), tone: `warning` };
    }
    return target.installed
        ? { label: t(`preview.previewPanel.deps`), value: t(`preview.previewPanel.installed`) }
        : { label: t(`preview.previewPanel.deps`), value: t(`preview.previewPanel.installFirst`), tone: `warning` };
};

const costNote = (target: PreviewTarget): string => {
    if (target.builds) {
        return target.installed ? t(`preview.previewPanel.rebuildsChanges`) : t(`preview.previewPanel.buildMinutes`);
    }
    return target.installed ? t(`preview.previewPanel.upInSeconds`) : t(`preview.previewPanel.takesMinutes`);
};

// The Start button's hover.
export const startTipOf = (target: PreviewTarget): Tip | undefined => {
    const session = startSessionOf(target);
    if (session === undefined) {
        return undefined;
    }
    return {
        title: target.runs === undefined ? t(`preview.previewPanel.devServer`) : t(`preview.previewPanel.whatStartRuns`),
        rows: [
            { label: t(`preview.previewPanel.repo`), value: target.repo ?? `` },
            { label: t(`preview.previewPanel.app`), value: target.app ?? `` },
            { label: t(`preview.previewPanel.runs`), value: target.runs ?? `` },
            { label: t(`shared.terminal`), value: session },
            costRow(target),
        ],
        note: costNote(target),
    };
};
