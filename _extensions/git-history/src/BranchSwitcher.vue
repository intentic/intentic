<script setup lang="ts">
import { Button, Icon, Popover, SearchBar, timeAgo, ui } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { startAgentFrom, viewInWorkspace } from "./branchActions.js";
import { useBranches } from "./useBranches.js";
import { t } from "./i18n.js";

// Graph header's branch list: the branch the shared workspace stands on as a pill, and a popover of every branch to
// view in the Workspace or start an agent from, create or delete. Nothing here switches the shared checkout: it stays on
// its main line. Not a bare `<select>`, since a row carries upstream/ahead-behind state and delete needs a confirm step.
// All git access is one composable call away; this component owns only the popover's local state.

const { repo } = defineProps<{ repo: string }>();
const repoRef = computed(() => repo);
const { groups, current, busy, actionError, create, remove } = useBranches(repoRef);

const popover = ref<InstanceType<typeof Popover>>();
const filter = ref(``);
const creating = ref(false);
const newName = ref(``);
// Two-step delete: the first click arms a branch, the second runs it.
const armedDelete = ref<string | undefined>(undefined);
// Set when git refuses to delete for unmerged commits; the force retry is offered only after that refusal.
const forceFor = ref<string | undefined>(undefined);

// Filters by the group's shared name, so `main`/`origin/main` share a row; already ordered, so no re-sort.
const shown = computed(() => {
    const needle = filter.value.trim().toLowerCase();
    return needle === `` ? groups.value : groups.value.filter((group) => group.name.toLowerCase().includes(needle));
});

// A row's name is already the short one a view and a start take (groupBranches keys a remote by its branch part), so a
// remote-only branch needs no folding here: the daemon makes the local one when it is first needed.
const view = (name: string): void => {
    popover.value?.hide();
    viewInWorkspace(repo, name);
};
const startFrom = (name: string): void => {
    popover.value?.hide();
    startAgentFrom(repo, name);
};

const toggle = (event: Event): void => {
    filter.value = ``;
    creating.value = false;
    armedDelete.value = undefined;
    forceFor.value = undefined;
    popover.value?.toggle(event);
};

const submitCreate = async (): Promise<void> => {
    const name = newName.value.trim();
    // `create` drops its own re-entry, so a second Enter would otherwise fall straight through to the success branch
    // and close the field while the first create is still running.
    if (name === `` || busy.value) {
        return;
    }
    // From HEAD, which stays where it is. The list narrows to the new row, so its view and start are the next press.
    await create(name);
    if (actionError.value === undefined) {
        newName.value = ``;
        creating.value = false;
        filter.value = name;
    }
};

const askDelete = (name: string): void => {
    armedDelete.value = armedDelete.value === name ? undefined : name;
};

const confirmDelete = async (name: string): Promise<void> => {
    const force = forceFor.value === name;
    await remove(name, force);
    if (actionError.value === undefined) {
        armedDelete.value = undefined;
        forceFor.value = undefined;
        return;
    }
    // git refused for unmerged commits; the force retry appears only after that refusal, not up front.
    forceFor.value = name;
};
</script>

<template>
    <div class="flex min-w-0 items-center">
        <button
            type="button"
            :disabled="busy"
            :class="ui.textButton({ tone: `quiet` }, `touch-target inline-flex min-w-0 select-none font-medium`)"
            v-tooltip.bottom="t(`branchSwitcher.branches`)"
            :aria-label="t(`branchSwitcher.branch`)"
            @click="toggle"
        >
            <Icon name="code" class="shrink-0 text-3xs" />
            <span class="truncate text-content">{{ current?.name ?? t(`branchSwitcher.detached`) }}</span>
            <span v-if="current && current.behind > 0" class="shrink-0 text-muted">↓{{ current.behind }}</span>
            <span v-if="current && current.ahead > 0" class="shrink-0 text-muted">↑{{ current.ahead }}</span>
            <Icon name="chevron-down" class="shrink-0 text-4xs" />
        </button>

        <Popover ref="popover">
            <div class="flex w-80 flex-col gap-1.5">
                <p class="text-2xs text-subtle">{{ t(`branchSwitcher.caption`) }}</p>
                <SearchBar
                    v-model="filter"
                    variant="field"
                    clearable
                    :aria-label="t(`branchSwitcher.filterBranches`)"
                    :placeholder="t(`branchSwitcher.filterBranches2`)"
                />

                <p v-if="actionError" class="truncate text-2xs text-danger" v-tooltip.bottom.overflow="actionError">{{ actionError }}</p>

                <div class="flex max-h-64 flex-col overflow-auto">
                    <!-- One row per line of work: `main` and `origin/main` share a row, named once with remote pills after it. -->
                    <template v-for="branch in shown" :key="branch.name">
                        <div class="group/row flex items-center gap-1 rounded transition-colors hover:bg-overlay">
                            <div class="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1">
                                <Icon
                                    :name="branch.local?.current ? 'check' : branch.local ? 'code' : 'cloud'"
                                    class="shrink-0 text-3xs"
                                    :class="branch.local?.current ? 'text-success' : 'text-subtle'"
                                />
                                <span class="min-w-0 flex-1 truncate text-xs" :class="branch.local?.current ? 'text-content' : 'text-muted'">{{
                                    branch.name
                                }}</span>
                                <!-- Remotes named, not counted: "on origin" and "on my fork" are different facts. -->
                                <span
                                    v-for="entry in branch.remotes"
                                    :key="entry.name"
                                    class="shrink-0 rounded bg-overlay px-1 text-3xs text-subtle"
                                    v-tooltip.top="entry.name"
                                    >{{ entry.remote }}</span
                                >
                                <!-- "gone" means the upstream was deleted, usually a merged PR; different from never having one. -->
                                <span
                                    v-if="branch.local?.gone"
                                    class="shrink-0 text-2xs text-warning"
                                    v-tooltip.top="t(`branchSwitcher.upstreamBranchDeleted`)"
                                    >{{ t(`branchSwitcher.gone`) }}</span
                                >
                                <span v-if="(branch.local?.behind ?? 0) > 0" class="shrink-0 text-2xs text-subtle">↓{{ branch.local!.behind }}</span>
                                <span v-if="(branch.local?.ahead ?? 0) > 0" class="shrink-0 text-2xs text-subtle">↑{{ branch.local!.ahead }}</span>
                                <span class="shrink-0 text-2xs text-subtle">{{ timeAgo(branch.at) }}</span>
                            </div>
                            <!-- The branch the shared workspace stands on is what the Workspace already shows: named, not offered. -->
                            <span v-if="branch.local?.current" class="shrink-0 pr-1.5 text-2xs text-subtle">{{ t(`branchSwitcher.workspace`) }}</span>
                            <template v-else>
                                <button
                                    type="button"
                                    :class="ui.iconButton({ size: `xs`, tone: `subtle` })"
                                    v-tooltip.top="{ title: t(`branchActions.view`) }"
                                    :aria-label="t(`branchActions.viewNamed`, { branch: branch.name })"
                                    @click="view(branch.name)"
                                >
                                    <Icon name="eye" class="text-2xs" />
                                </button>
                                <button
                                    type="button"
                                    :class="ui.iconButton({ size: `xs`, tone: `subtle` })"
                                    v-tooltip.top="{ title: t(`branchActions.start`) }"
                                    :aria-label="t(`branchActions.startNamed`, { branch: branch.name })"
                                    @click="startFrom(branch.name)"
                                >
                                    <Icon name="robot" class="text-2xs" />
                                </button>
                            </template>
                            <!-- Only a local branch can be deleted here; a remote one belongs to somebody else's repository. -->
                            <button
                                v-if="branch.local && !branch.local.current"
                                type="button"
                                :class="
                                    ui.iconButton(
                                        { size: `xs`, tone: `danger`, on: armedDelete === branch.name },
                                        `opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100`,
                                        armedDelete === branch.name ? `opacity-100` : ``,
                                    )
                                "
                                :disabled="busy"
                                @click="askDelete(branch.name)"
                                v-tooltip.top="t(`branchSwitcher.deleteBranch`)"
                                :aria-label="t(`branchSwitcher.deleteBranch`)"
                            >
                                <Icon name="trash" class="text-2xs" />
                            </button>
                        </div>
                        <div v-if="armedDelete === branch.name" class="flex items-center gap-2 px-1.5 pb-1">
                            <span class="flex-1 text-2xs text-warning">
                                {{
                                    forceFor === branch.name
                                        ? t(`branchSwitcher.unmergedForceDelete`)
                                        : t(`branchSwitcher.delete`, { name: branch.name })
                                }}
                            </span>
                            <button type="button" class="text-2xs text-muted hover:text-content" @click="armedDelete = undefined">
                                {{ t(`branchSwitcher.cancel`) }}
                            </button>
                            <Button tier="accent" size="small" tone="danger" :disabled="busy" @click="() => confirmDelete(branch.name)">
                                {{ forceFor === branch.name ? t(`branchSwitcher.forceDelete`) : t(`branchSwitcher.delete2`) }}
                            </Button>
                        </div>
                    </template>
                    <p v-if="shown.length === 0" class="px-1.5 py-2 text-2xs text-subtle">{{ t(`branchSwitcher.noBranchesMatch`) }}</p>
                </div>

                <div class="border-t border-line-subtle pt-1.5">
                    <button
                        v-if="!creating"
                        type="button"
                        class="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted transition-colors hover:bg-overlay hover:text-content"
                        @click="creating = true"
                    >
                        <Icon name="plus" class="text-2xs" />
                        {{ t(`branchSwitcher.newBranchHere`) }}
                    </button>
                    <div v-else class="flex items-center gap-1.5">
                        <input
                            v-model="newName"
                            type="text"
                            placeholder="branch-name"
                            autofocus
                            class="ui-field-box ui-field-sm min-w-0 flex-1"
                            @keyup.enter="submitCreate"
                            @keydown.escape="creating = false"
                        />
                        <Button size="small" tier="accent" :disabled="busy || newName.trim() === ''" @click="submitCreate">
                            {{ t(`branchSwitcher.create`) }}
                        </Button>
                    </div>
                </div>
            </div>
        </Popover>
    </div>
</template>
