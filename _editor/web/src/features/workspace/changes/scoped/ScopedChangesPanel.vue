<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { Button, ChangeStatusMark, Notice, timeAgo, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { DiffPayload } from "@intentic/extension-api";
import type { GitChange } from "@intentic/sandbox-contract/schemas/git/git";
import { computed, onScopeDispose, ref } from "vue";
import { workspaceView } from "../../../../app/workspaceScope";
import { useScopeTitle } from "../../health/scopeTitle";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { diffRawUrls, type DiffRawSource } from "../../../../models/workspace/changes/diffRaw";
import type { OpenMode } from "../../../../models/workspace/tabs/workspaceTabs";
import ChangeRowName from "../../../../components/ChangeRowName.vue";
import ReviewStat from "../ReviewStat.vue";
import { basename } from "@intentic/ui/path";

type Source = Extract<DiffRawSource, { source: "agent" | "commit" }>;
interface Group {
    readonly key: string;
    readonly label: string;
    readonly source: Source;
    readonly changes: readonly GitChange[];
}

const t = useT();
const emit = defineEmits<{ "open-diff": [payload: DiffPayload, mode: OpenMode] }>();
const scope = computed(() => workspaceView.value);
const onBranch = computed(() => scope.value.branch !== undefined);
const before = ref<string>();
const picked = ref<string>();
const opening = ref<string>();
const openError = ref<string>();
let request = 0;
let active = true;
onScopeDispose(() => { active = false; });

const landings = useSandboxQuery({
    ...rpcQuery(`git.branchLandings`, () => ({ repo: scope.value.repo ?? `root`, branch: scope.value.branch ?? ``, before: before.value })),
    enabled: onBranch,
});
const agent = useSandboxQuery({
    ...rpcQuery(`agents.diff`, () => ({ id: scope.value.agent ?? `` })),
    enabled: computed(() => scope.value.agent !== undefined),
});
const history = useSandboxQuery({
    ...rpcQuery(`agents.history`, () => ({ id: scope.value.agent ?? `` })),
    enabled: computed(() => scope.value.agent !== undefined && (agent.query.data.value?.absorbed ?? 0) > 0),
});
const selected = computed(() => landings.query.data.value?.commits.find((commit) => commit.sha === picked.value) ?? landings.query.data.value?.commits[0]);
const files = useSandboxQuery({
    ...rpcQuery(`git.commitDiff`, () => ({ repo: scope.value.repo ?? `root`, sha: selected.value?.sha ?? `` })),
    enabled: computed(() => onBranch.value && selected.value !== undefined),
});
const commits = computed(() => landings.query.data.value?.commits ?? []);
const title = useScopeTitle();
const groups = computed<readonly Group[]>(() => {
    const current = scope.value;
    if (current.branch !== undefined) {
        const commit = selected.value;
        return commit === undefined ? [] : [{
            key: commit.sha, label: commit.short,
            source: { source: `commit`, repo: current.repo, sha: commit.sha }, changes: files.query.data.value?.files ?? [],
        }];
    }
    if (current.agent === undefined) { return []; }
    const id = current.agent;
    const source = (repo: string): Source => ({ source: `agent`, repo, agent: id });
    return [
        ...(agent.query.data.value?.repos ?? []).map((repo) => ({ key: repo.repo, label: repo.repo, source: source(repo.repo), changes: repo.changes })),
        ...(history.query.data.value?.repos ?? []).flatMap((repo) => repo.commits.map((commit) => ({
            key: `${repo.repo}:${commit.sha}`, label: `${repo.repo} · ${commit.subject}`, source: source(repo.repo), changes: commit.changes,
        }))),
    ];
});
const reading = computed(() => onBranch.value ? landings.query : agent.query);
const error = computed(() => onBranch.value ? landings.error.value : agent.error.value);
const page = (cursor?: string): void => { before.value = cursor; picked.value = undefined; openError.value = undefined; };
const refresh = (): void => {
    openError.value = undefined;
    if (onBranch.value) {
        if (before.value === undefined) { void landings.query.refetch(); }
        else { page(); }
    } else {
        void agent.query.refetch();
        if (history.query.data.value !== undefined) { void history.query.refetch(); }
    }
};

const open = async (group: Group, change: GitChange, mode: OpenMode): Promise<void> => {
    const source = group.source;
    const key = `${group.key}:${change.path}`;
    const run = ++request;
    opening.value = key;
    openError.value = undefined;
    try {
        const body = source.source === `commit`
            ? await sandboxRpc.git.commitFileDiff({ repo: source.repo, sha: source.sha, path: change.path })
            : await sandboxRpc.agents.fileDiff({ id: source.agent, repo: source.repo, path: change.path });
        if (!active || run !== request) { return; }
        emit(`open-diff`, {
            key: source.source === `commit` ? `commit:${source.repo}:${source.sha}` : `agent:${source.agent}:${source.repo}`,
            scope: source.repo, path: change.path,
            label: source.source === `commit` ? `${basename(change.path)} @ ${source.sha.slice(0, 7)}` : (source.repo === `root` ? change.path : `${source.repo}/${change.path}`),
            status: change.status, additions: change.additions, deletions: change.deletions,
            ...diffRawUrls(source, change.path, change.status), ...body,
        }, mode);
    } catch (failure) {
        if (active && run === request) { openError.value = errorMessage(failure); }
    } finally {
        if (run === request) { opening.value = undefined; }
    }
};
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col" data-scoped-changes>
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-2">
            <span class="min-w-0 flex-1 truncate text-xs font-medium" :title="title">{{ title }}</span>
            <button type="button" :class="ui.iconButton()" :aria-label="t(`ui.action.refresh`)" :disabled="reading.isFetching.value" @click="refresh">
                <Icon name="refresh" class="text-xs" :spin="reading.isFetching.value" />
            </button>
        </div>
        <p class="shrink-0 px-2.5 py-2 text-2xs text-subtle">
            {{ onBranch ? t(`workspace.scopedChanges.branchHint`) : t(`workspace.scopedChanges.sessionHint`) }}
        </p>
        <Notice v-if="error" tone="danger" size="sm" class="mx-2 mb-2">{{ error }}</Notice>
        <p v-else-if="reading.isPending.value" class="px-2.5 py-2 text-2xs text-subtle">{{ t(`workspace.scopedChanges.loading`) }}</p>
        <div v-else class="min-h-0 flex-1 overflow-y-auto">
            <template v-if="onBranch">
                <p v-if="commits.length === 0" class="px-2.5 py-2 text-2xs text-subtle">
                    {{ t(`workspace.scopedChanges.noLandings`, { branch: landings.query.data.value?.mainBranch ?? `` }) }}
                </p>
                <div v-for="commit in commits" :key="commit.sha" class="border-b border-line">
                    <button type="button" class="flex w-full flex-col gap-1 px-2.5 py-2 text-left hover:bg-content/5" :aria-expanded="selected?.sha === commit.sha" @click="picked = commit.sha">
                        <span class="line-clamp-2 text-2xs font-medium text-content">{{ commit.subject }}</span>
                        <span class="flex w-full items-center gap-2 text-2xs text-subtle">
                            <span class="min-w-0 flex-1 truncate" :title="commit.agent">{{ commit.agent }}</span>
                            <span>{{ commit.short }}</span><span>{{ timeAgo(commit.at) }}</span>
                        </span>
                    </button>
                    <template v-if="selected?.sha === commit.sha">
                        <Notice v-if="files.error.value" tone="danger" size="sm" class="mx-2 mb-2">{{ files.error.value }}</Notice>
                        <p v-else-if="files.query.isPending.value" class="px-2.5 py-2 text-2xs text-subtle">{{ t(`workspace.scopedChanges.loading`) }}</p>
                        <template v-else v-for="group in groups" :key="group.key">
                            <button v-for="change in group.changes" :key="change.path" type="button" class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-content/5" :aria-busy="opening === `${group.key}:${change.path}`" @click="open(group, change, `preview`)" @dblclick="open(group, change, `keep`)">
                                <ChangeStatusMark :status="change.status" />
                                <ChangeRowName :path="change.path" :label="change.path" :named="false" />
                                <ReviewStat :additions="change.additions" :deletions="change.deletions" />
                            </button>
                        </template>
                    </template>
                </div>
                <div v-if="before || landings.query.data.value?.next" class="flex items-center gap-2 px-2.5 py-2">
                    <Button v-if="before" size="small" tier="quiet" @click="page()">{{ t(`workspace.scopedChanges.latest`) }}</Button>
                    <Button v-if="landings.query.data.value?.next" size="small" tier="quiet" @click="page(landings.query.data.value.next)">{{ t(`workspace.scopedChanges.older`) }}</Button>
                </div>
            </template>
            <template v-else>
                <div v-for="group in groups" :key="group.key" class="border-b border-line py-1">
                    <p class="truncate px-2.5 py-1 text-2xs font-medium text-subtle" :title="group.label">{{ group.label }}</p>
                    <button v-for="change in group.changes" :key="change.path" type="button" class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-content/5" :aria-busy="opening === `${group.key}:${change.path}`" @click="open(group, change, `preview`)" @dblclick="open(group, change, `keep`)">
                        <ChangeStatusMark :status="change.status" />
                        <ChangeRowName :path="change.path" :label="change.path" :named="false" />
                        <ReviewStat :code="change.code" :additions="change.additions" :deletions="change.deletions" />
                    </button>
                </div>
                <Notice v-if="history.error.value" tone="danger" size="sm" class="mx-2 my-2">{{ history.error.value }}</Notice>
                <p v-else-if="history.query.isFetching.value" class="px-2.5 py-2 text-2xs text-subtle">{{ t(`workspace.scopedChanges.loading`) }}</p>
                <p v-else-if="groups.length === 0" class="px-2.5 py-2 text-2xs text-subtle">{{ t(`workspace.scopedChanges.noChanges`) }}</p>
            </template>
        </div>
        <Notice v-if="openError" tone="danger" size="sm" class="mx-2 my-2">{{ openError }}</Notice>
    </div>
</template>
