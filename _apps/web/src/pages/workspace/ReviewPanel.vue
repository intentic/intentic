<script setup lang="ts">
import type { GitChange } from "@intentic-app/api-contract";
import { ref } from "vue";
import { useChat } from "../../composables/chat/useChat";
import { useChanges } from "../../composables/workspace/useChanges";
import { type DiffTabPayload, STATUS_CLASS, STATUS_LETTER } from "./workspaceTabs";

/* The Changes review — a mode of the workspace's ONE left sidebar (Workspace.vue owns the aside, the resize
 * handle, and the Files|Changes|History mode switch), VSCode's SCM pattern over the real repos: uncommitted
 * work (yours and the agent's, plain `git status` vs HEAD) grouped by repo. Clicking a file opens a
 * HEAD↔worktree diff as a tab in the main editor area; commit and discard work per file or per repo. Commit is
 * a real git commit on the repo's own branch; discard restores the worktree from HEAD (untracked files are
 * deleted). The History panel stays the safety timeline underneath. */

const changes = useChanges();
// A commit mid-turn would sweep the agent's half-finished work into the repo — hold the buttons until it ends.
const { streaming } = useChat();
const emit = defineEmits<{ "open-diff": [payload: DiffTabPayload] }>();

const collapsed = ref<ReadonlySet<string>>(new Set());
const toggleGroup = (repo: string): void => {
    const next = new Set(collapsed.value);
    if (!next.delete(repo)) {
        next.add(repo);
    }
    collapsed.value = next;
};

const changeLabel = (repo: string, change: GitChange): string => (repo === `root` ? change.path : `${repo}/${change.path}`);

const openDiff = (repo: string, change: GitChange): void => {
    void changes.fileDiff(repo, change.path).then((body) => {
        emit(`open-diff`, {
            key: `working:${repo}`,
            scope: repo,
            label: changeLabel(repo, change),
            status: change.status,
            path: change.path,
            ...body,
        });
    });
};

// One inline action at a time, targeting a whole repo (path absent) or a single file: the commit-message
// composer and the two-step discard confirm render under the group header / file row they apply to.
const pendingCommit = ref<{ repo: string; path?: string } | undefined>(undefined);
const pendingDiscard = ref<{ repo: string; path?: string } | undefined>(undefined);
const commitMessage = ref(``);

const startCommit = (repo: string, path?: string): void => {
    pendingDiscard.value = undefined;
    pendingCommit.value = { repo, ...(path !== undefined ? { path } : {}) };
    commitMessage.value = ``;
};
const confirmCommit = (): void => {
    const pending = pendingCommit.value;
    if (pending === undefined || commitMessage.value.trim().length === 0) {
        return;
    }
    pendingCommit.value = undefined;
    void changes.commit(pending.repo, commitMessage.value, pending.path !== undefined ? [pending.path] : undefined);
};
const startDiscard = (repo: string, path?: string): void => {
    pendingCommit.value = undefined;
    pendingDiscard.value = { repo, ...(path !== undefined ? { path } : {}) };
};
const confirmDiscard = (): void => {
    const pending = pendingDiscard.value;
    if (pending === undefined) {
        return;
    }
    pendingDiscard.value = undefined;
    void changes.discard(pending.repo, pending.path !== undefined ? [pending.path] : undefined);
};

const isPending = (pending: { repo: string; path?: string } | undefined, repo: string, path?: string): boolean =>
    pending !== undefined && pending.repo === repo && pending.path === path;
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
            <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Changes</span>
            <span v-if="changes.count.value > 0" class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ changes.count.value }}</span>
            <span class="flex-1"></span>
            <Icon name="spinner" v-if="changes.actionBusy.value" v-tooltip.top="'Working…'" class="text-xs text-muted" spin />
            <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="changes.refresh()"
                v-tooltip.top="'Refresh'"
                aria-label="Refresh changes"
            >
                <Icon name="refresh" class="text-xs" :spin="changes.loading.value" />
            </button>
        </div>

        <p v-if="changes.error.value" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.bottom="changes.error.value">
            {{ changes.error.value }}
        </p>
        <p v-if="changes.actionError.value" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.bottom="changes.actionError.value">
            {{ changes.actionError.value }}
        </p>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
            <p v-if="changes.loading.value && changes.count.value === 0" class="px-3 py-2 text-2xs text-subtle">Loading changes…</p>
            <p v-else-if="changes.count.value === 0" class="px-3 py-2 text-2xs text-subtle">
                No uncommitted changes. Edits by you or the agent show up here to review, commit, or discard.
            </p>
            <div v-for="group in changes.repos.value" :key="group.repo" class="group/repo border-b border-line/50">
                <div class="flex items-center gap-1 pr-1 transition-colors hover:bg-overlay">
                    <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left max-md:min-h-11"
                        @click="toggleGroup(group.repo)"
                    >
                        <Icon class="text-2xs text-subtle" :name="collapsed.has(group.repo) ? 'chevron-right' : 'chevron-down'" />
                        <span class="truncate text-xs font-medium text-content">{{ group.repo }}</span>
                        <span v-if="group.branch !== undefined" class="truncate text-2xs text-subtle">{{ group.branch }}</span>
                        <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ group.changes.length }}</span>
                    </button>
                    <button
                        type="button"
                        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-colors hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover/repo:opacity-100 disabled:opacity-0"
                        :disabled="changes.actionBusy.value"
                        @click="startDiscard(group.repo)"
                        v-tooltip.top="'Discard all changes in this repo'"
                        aria-label="Discard all changes in this repo"
                    >
                        <Icon name="undo" class="text-2xs" />
                    </button>
                    <button
                        type="button"
                        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-colors hover:bg-overlay hover:text-success focus-visible:opacity-100 group-hover/repo:opacity-100 disabled:opacity-0"
                        :disabled="changes.actionBusy.value || streaming"
                        @click="startCommit(group.repo)"
                        v-tooltip.top="streaming ? 'Wait for the agent turn to finish' : 'Commit all changes in this repo'"
                        aria-label="Commit all changes in this repo"
                    >
                        <Icon name="check" class="text-2xs" />
                    </button>
                </div>

                <div v-if="isPending(pendingCommit, group.repo)" class="flex flex-col gap-1.5 px-2 pb-2">
                    <input
                        v-model="commitMessage"
                        type="text"
                        placeholder="Commit message"
                        class="w-full min-w-0 rounded-md border border-line bg-canvas px-2 py-1 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                        @keydown.enter="confirmCommit"
                        @keydown.esc="pendingCommit = undefined"
                    />
                    <div class="flex items-center justify-end gap-2">
                        <button type="button" class="text-2xs text-muted hover:text-content" @click="pendingCommit = undefined">Cancel</button>
                        <button
                            type="button"
                            class="inline-flex items-center whitespace-nowrap rounded-md bg-success px-2.5 py-1 text-2xs font-medium text-white transition-colors hover:bg-success/85 disabled:opacity-40"
                            :disabled="changes.actionBusy.value || streaming || commitMessage.trim().length === 0"
                            @click="confirmCommit"
                        >
                            <Icon name="check" class="mr-1 text-2xs" />Commit {{ group.changes.length }}
                            {{ group.changes.length === 1 ? "change" : "changes" }}
                        </button>
                    </div>
                </div>
                <div v-else-if="isPending(pendingDiscard, group.repo)" class="flex flex-col gap-1.5 px-2 pb-2">
                    <span class="text-2xs text-warning">Discard all changes in {{ group.repo }}? Untracked files are deleted.</span>
                    <div class="flex items-center justify-end gap-2">
                        <button type="button" class="text-2xs text-muted hover:text-content" @click="pendingDiscard = undefined">Cancel</button>
                        <button
                            type="button"
                            class="rounded border border-danger/50 px-2 py-0.5 text-2xs text-danger transition-colors hover:bg-danger/10"
                            :disabled="changes.actionBusy.value"
                            @click="confirmDiscard"
                        >
                            Discard
                        </button>
                    </div>
                </div>

                <div v-if="!collapsed.has(group.repo)" class="pb-1 pl-4 pr-1">
                    <template v-for="change in group.changes" :key="`${group.repo}/${change.path}`">
                        <div class="group/file flex items-center gap-1 rounded transition-colors hover:bg-overlay">
                            <button
                                type="button"
                                class="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5 text-left max-md:min-h-11"
                                @click="openDiff(group.repo, change)"
                                :title="changeLabel(group.repo, change)"
                            >
                                <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[change.status]">{{
                                    STATUS_LETTER[change.status]
                                }}</span>
                                <span class="truncate text-2xs text-muted max-md:text-xs" dir="rtl">{{ change.path }}</span>
                            </button>
                            <button
                                type="button"
                                class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-colors hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover/file:opacity-100 disabled:opacity-0"
                                :disabled="changes.actionBusy.value"
                                @click="startDiscard(group.repo, change.path)"
                                v-tooltip.top="'Discard this file'"
                                aria-label="Discard this file"
                            >
                                <Icon name="undo" class="text-2xs" />
                            </button>
                            <button
                                type="button"
                                class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-colors hover:bg-overlay hover:text-success focus-visible:opacity-100 group-hover/file:opacity-100 disabled:opacity-0"
                                :disabled="changes.actionBusy.value || streaming"
                                @click="startCommit(group.repo, change.path)"
                                v-tooltip.top="streaming ? 'Wait for the agent turn to finish' : 'Commit this file'"
                                aria-label="Commit this file"
                            >
                                <Icon name="check" class="text-2xs" />
                            </button>
                        </div>

                        <div v-if="isPending(pendingCommit, group.repo, change.path)" class="flex flex-col gap-1.5 px-1 pb-1.5">
                            <input
                                v-model="commitMessage"
                                type="text"
                                placeholder="Commit message"
                                class="w-full min-w-0 rounded-md border border-line bg-canvas px-2 py-1 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                                @keydown.enter="confirmCommit"
                                @keydown.esc="pendingCommit = undefined"
                            />
                            <div class="flex items-center justify-end gap-2">
                                <button type="button" class="text-2xs text-muted hover:text-content" @click="pendingCommit = undefined">
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    class="inline-flex items-center whitespace-nowrap rounded-md bg-success px-2.5 py-1 text-2xs font-medium text-white transition-colors hover:bg-success/85 disabled:opacity-40"
                                    :disabled="changes.actionBusy.value || streaming || commitMessage.trim().length === 0"
                                    @click="confirmCommit"
                                >
                                    <Icon name="check" class="mr-1 text-2xs" />Commit file
                                </button>
                            </div>
                        </div>
                        <div v-else-if="isPending(pendingDiscard, group.repo, change.path)" class="flex flex-col gap-1.5 px-1 pb-1.5">
                            <span class="text-2xs text-warning">
                                Discard {{ change.path }}?{{ change.status === "added" ? " The file is deleted." : "" }}
                            </span>
                            <div class="flex items-center justify-end gap-2">
                                <button type="button" class="text-2xs text-muted hover:text-content" @click="pendingDiscard = undefined">
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    class="rounded border border-danger/50 px-2 py-0.5 text-2xs text-danger transition-colors hover:bg-danger/10"
                                    :disabled="changes.actionBusy.value"
                                    @click="confirmDiscard"
                                >
                                    Discard
                                </button>
                            </div>
                        </div>
                    </template>
                </div>
            </div>
        </div>
    </div>
</template>
