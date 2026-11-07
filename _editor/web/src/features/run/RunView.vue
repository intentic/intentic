<!-- THE RUN VIEW: what runs where, and what can be started where. One lane per place a program runs, the sandbox first
     and then each of the owner's computers, so a program running natively on another machine is in sight beside the
     sandbox's own servers. The repository picker at the top right narrows every lane to one repository, the open project
     to its own; a link from a repository's row in the Workspace arrives picked. -->
<script setup lang="ts">
import { RUN_TARGETS_FILE } from "@intentic/sandbox-contract/schemas/run-targets";
import {
    Button,
    EmptyState,
    Icon,
    Notice,
    PageAction,
    type PickerOption,
    ProjectChip,
    RepoPicker,
    type RepoPickerAll,
    RowGroup,
    SkeletonRows,
    SplitView,
} from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, provide, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { projectScope, setProjectScope, withinScope } from "../../app/projectScope";
import { usePanels } from "../../models/extensions/usePanels";
import { composeAgent } from "../../models/fleet/agentActions";
import { runFileFix } from "../../models/runs/runFixes";
import { useEveryDeviceRuns, useRunTargets } from "../../models/runs/useRunTargets";
import { useWorkspaceTabs } from "../../models/workspace/tabs/useWorkspaceTabs";
import FixWithAgent from "../../parts/fleet/FixWithAgent.vue";
import { usePreviewTargets } from "../preview/usePreviewTargets";
import { RUN_ACTIONS, useRunActions } from "./runActions";
import RunLane from "./RunLane.vue";
import { narrowLanes, type RunRepo, runLanesOf, runningCount } from "./runLanes";

const t = useT();
const route = useRoute();
const router = useRouter();

const { repos: declared, devices, error: readError } = useRunTargets();
const { allPanels } = usePanels();
// Mounted is shown: the live sandbox apps and the computers' lists are read while the view is up, and no longer.
const visible = ref(true);
const live = usePreviewTargets(visible);
const { openFile } = useWorkspaceTabs();

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
// The open project's repositories; the rest are counted on its chip.
const inProject = computed(() => repos.value.filter(({ repo }) => withinScope(repo)));
const projectHidden = computed(() => repos.value.length - inProject.value.length);

// The computers that can say what runs on them, asked together on a clock while the view is up.
const listed = computed(() => devices.value.filter((device) => device.online && device.programs).map((device) => device.id));
const { runsOn } = useEveryDeviceRuns(listed, visible);

// Every lane of the open project, then narrowed to the picked repository: the picker counts what each one runs.
const allLanes = computed(() =>
    runLanesOf({
        repos: repos.value,
        live: live.targets.value,
        devices: devices.value,
        runsOn,
        // A program no repository is known for is the workspace's, shown while no project narrows it.
        inScope: (repo) => (repo === undefined ? projectScope.value === undefined : withinScope(repo)),
    }),
);

// The picked repository lives in the address (`?repo=`), so a link from the Workspace opens on it and Back works; one the
// workspace no longer has falls back to every repository.
const picked = computed<string | undefined>({
    get: () => inProject.value.find(({ repo }) => repo === route.query[`repo`])?.repo,
    set: (repo) => void router.replace({ query: { ...route.query, repo } }),
});
const lanes = computed(() => narrowLanes(allLanes.value, picked.value));
const running = computed(() => runningCount(lanes.value));

const repoOptions = computed<PickerOption[]>(() =>
    inProject.value.map(({ repo, declared: file }) => {
        const count = runningCount(allLanes.value, repo);
        const targets = file?.targets.length ?? 1;
        return {
            value: repo,
            label: repo,
            icon: `folder`,
            description: count > 0 ? t(`run.view.runningCount`, { count }, count) : t(`run.view.targetsCount`, { count: targets }, targets),
            mono: true,
        };
    }),
);
const everyRepo = computed<RepoPickerAll>(() => {
    const count = runningCount(allLanes.value);
    return { icon: `play`, description: t(`run.view.runningCount`, { count }, count) };
});

const actions = useRunActions(router, live, lanes, visible);
provide(RUN_ACTIONS, actions);

// The picked repository's file: the source of truth, opened where it is edited.
const pickedFile = computed(() => (picked.value === undefined ? undefined : declared.value?.find((entry) => entry.repo === picked.value)));
const fileName = RUN_TARGETS_FILE.split(`/`).at(-1) ?? RUN_TARGETS_FILE;
// Files that do not parse, in what is shown: said first, since a target missing from a lane is otherwise unexplained.
const broken = computed(() => (declared.value ?? []).filter((entry) => entry.error !== undefined && withinScope(entry.repo) && (picked.value ?? entry.repo) === entry.repo));

// Read: the files have answered (or failed to). Before that an empty view is only not known yet.
const read = computed(() => declared.value !== undefined || readError.value !== undefined);
const nothing = computed(() => read.value && lanes.value.length === 0 && broken.value.length === 0);

const makeRunnable = (): void => {
    if (picked.value !== undefined) {
        composeAgent(t(`preview.previewPanel.makeStartablePrompt`, { repo: picked.value }));
    }
};

const EXAMPLE = `{
  "targets": [
    { "name": "web", "command": "pnpm dev" },
    {
      "name": "app",
      "device": "my-pc",
      "build": "cargo xwin build --release --target x86_64-pc-windows-msvc",
      "artifact": "target/x86_64-pc-windows-msvc/release/app.exe"
    }
  ]
}`;
</script>

<template>
    <SplitView :title="t(`run.view.title`)" scroll="page" :scroll-key="picked">
        <template v-if="running > 0" #info>
            <span class="ml-1 text-xs tabular-nums text-subtle">{{ t(`run.view.runningCount`, { count: running }, running) }}</span>
        </template>

        <template #actions>
            <!-- The open project, and the way out of it: the same scope every other area narrows by. -->
            <ProjectChip :project="projectScope" :hidden="projectHidden" noun="repositories" @clear="setProjectScope(undefined)" />
            <RepoPicker v-model="picked" :repos="repoOptions" :all="everyRepo" memory="run.repo" />
            <PageAction
                v-if="pickedFile !== undefined"
                quiet
                icon="file-edit"
                :label="t(`run.view.editFile`, { file: fileName })"
                :hint="pickedFile.path"
                @click="openFile(pickedFile.path)"
            />
        </template>

        <template #strips>
            <Notice v-if="readError !== undefined" tone="danger" size="sm">{{ readError }}</Notice>
            <Notice v-for="entry in broken" :key="entry.repo" tone="danger" size="sm">
                <span class="font-mono">{{ entry.path }}</span>: {{ entry.error }}
                <template #actions>
                    <FixWithAgent :fix="runFileFix({ repo: entry.repo, reason: entry.error!, title: t(`run.view.fileUnreadable`) })" />
                </template>
            </Notice>
            <Notice v-if="actions.sandboxFailure.value !== undefined" tone="danger" size="sm">
                {{ actions.sandboxFailure.value.text }}
                <template #actions><FixWithAgent :fix="actions.sandboxFailure.value.fix" /></template>
            </Notice>
            <Notice v-if="actions.failure.value !== undefined" tone="danger" size="sm">{{ actions.failure.value }}</Notice>
        </template>

        <template #detail>
            <div class="flex flex-col gap-7">
                <RowGroup v-if="!read"><SkeletonRows :rows="3" description control /></RowGroup>
                <RunLane v-for="lane in lanes" :key="lane.place" :lane="lane" :show-repo="picked === undefined" />

                <!-- Nothing says how to run it: an agent can work that out, or the file can be written by hand. -->
                <EmptyState
                    v-if="nothing"
                    icon="play"
                    :title="picked === undefined ? t(`run.view.nothingToRun`) : t(`run.view.declaresNothing`)"
                    :line="picked === undefined ? t(`run.view.nothingToRunLine`) : `${picked}/${RUN_TARGETS_FILE}`"
                >
                    <template v-if="picked !== undefined" #actions>
                        <Button tier="accent" :label="t(`preview.previewPanel.makeStartable`)" size="small" @click="makeRunnable">
                            <template #icon><Icon name="sparkles" /></template>
                        </Button>
                    </template>
                    <pre class="mx-auto mt-4 max-w-full overflow-x-auto rounded-lg bg-canvas px-3 py-2 text-left font-mono text-2xs text-content">{{ EXAMPLE }}</pre>
                </EmptyState>
            </div>
        </template>
    </SplitView>
</template>
