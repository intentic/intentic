import { computed, type Ref } from "vue";
import { withinScope, projectScope } from "../../app/projectScope";
import { usePanels } from "../../models/extensions/usePanels";
import { useEveryDeviceRuns, useRunTargets } from "../../models/runs/useRunTargets";
import { usePreviewTargets } from "../preview/usePreviewTargets";
import { type RunRepo, runLanesOf } from "./runLanes";

// THE RUN VIEW'S LANES, read: what every repository declares and what runs on the sandbox and each computer, made into
// lanes of the open project (runLanes.ts). One reading for the view and the rail's Run tile, so the number on the tile is
// the number on the page it opens. `active` holds every read off while nothing shows them; `pollMs` is how often the
// computers are asked again (the view asks often, the tile seldom; the faster of the two wins while both are up).
export function useRunLanes(active: Ref<boolean>, pollMs?: number) {
    const { repos: declared, devices, error: readError } = useRunTargets(active);
    const { allPanels } = usePanels();
    const live = usePreviewTargets(active);

    // Every repository with something to run: what its .intentic/run.json declares (a file that does not parse included,
    // so its error is said), else the one run Start finds in its own files.
    const repos = computed<readonly RunRepo[]>(() => {
        const files = new Map((declared.value ?? []).map((entry) => [entry.repo, entry]));
        const started = allPanels.value.filter((panel) => panel.start !== undefined).map((panel) => panel.repo);
        return [...new Set([...files.keys(), ...started])].map((repo) => ({
            repo,
            declared: files.get(repo),
            panel: allPanels.value.find((panel) => panel.repo === repo),
        }));
    });

    // The computers that can say what runs on them, asked together on a clock.
    const listed = computed(() => devices.value.filter((device) => device.online && device.programs).map((device) => device.id));
    const { runsOn } = useEveryDeviceRuns(listed, active, pollMs);

    // Every lane of the open project; the view narrows them to its picked repository after.
    const lanes = computed(() =>
        runLanesOf({
            repos: repos.value,
            live: live.targets.value,
            devices: devices.value,
            runsOn,
            // A program no repository is known for is the workspace's, shown while no project narrows it.
            inScope: (repo) => (repo === undefined ? projectScope.value === undefined : withinScope(repo)),
        }),
    );

    return { declared, readError, repos, live, lanes };
}
