<script setup lang="ts">
import { Button, Icon, Popover, SearchBar, timeAgo, vAction, ui } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { useBranches } from "./useBranches.js";

// Graph header's branch control: current branch as a pill, a popover to switch, create or delete. Not a bare
// `<select>`, since a row carries upstream/ahead-behind state and delete needs a confirm step. All git access is one
// composable call away; this component owns only the popover's local state.

const { repo } = defineProps<{ repo: string }>();
const repoRef = computed(() => repo);
const { groups, current, busy, actionError, checkout, create, remove } = useBranches(repoRef);

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

// Checking out a remote-only branch creates the local tracking branch, since plain `git checkout <name>` already does
// that when exactly one remote matches.
const pick = async (name: string): Promise<void> => {
    if (name === current.value?.name) {
        popover.value?.hide();
        return;
    }
    await checkout(name);
    if (actionError.value === undefined) {
        popover.value?.hide();
    }
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
    if (name === ``) {
        return;
    }
    // From HEAD, and switch to it: "new branch from here", the gesture people actually mean.
    await create(name, { checkout: true });
    if (actionError.value === undefined) {
        newName.value = ``;
        creating.value = false;
        popover.value?.hide();
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
            :class="ui.textAction('touch-target inline-flex min-w-0 select-none gap-1 font-medium text-content')"
            v-tooltip.bottom="'Switch, create or delete a branch'"
            aria-label="Branch"
            @click="toggle"
        >
            <Icon name="code" class="shrink-0 text-3xs" />
            <span class="truncate">{{ current?.name ?? "detached" }}</span>
            <span v-if="current && current.behind > 0" class="shrink-0 text-muted">↓{{ current.behind }}</span>
            <span v-if="current && current.ahead > 0" class="shrink-0 text-muted">↑{{ current.ahead }}</span>
            <Icon name="chevron-down" class="shrink-0 text-4xs" />
        </button>

        <Popover ref="popover">
            <div class="flex w-72 flex-col gap-1.5">
                <SearchBar v-model="filter" variant="field" clearable aria-label="Filter branches" placeholder="Filter branches…" />

                <p v-if="actionError" class="truncate text-2xs text-danger" v-tooltip.bottom.overflow="actionError">{{ actionError }}</p>

                <div class="scrollbar-thin flex max-h-64 flex-col overflow-auto">
                    <!--
                        One row per line of work: `main` and `origin/main` share a row, named once with remote pills after it. No local branch means
                        somebody else pushed it.
                    -->
                    <template v-for="branch in shown" :key="branch.name">
                        <div class="group/row flex items-center gap-1 rounded transition-colors hover:bg-overlay">
                            <button
                                type="button"
                                class="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left"
                                :disabled="busy"
                                v-action="() => pick(branch.name)"
                            >
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
                                <span v-if="branch.local?.gone" class="shrink-0 text-2xs text-warning" v-tooltip.top="'Upstream branch was deleted'"
                                    >gone</span
                                >
                                <span v-if="(branch.local?.behind ?? 0) > 0" class="shrink-0 text-2xs text-subtle">↓{{ branch.local!.behind }}</span>
                                <span v-if="(branch.local?.ahead ?? 0) > 0" class="shrink-0 text-2xs text-subtle">↑{{ branch.local!.ahead }}</span>
                                <span class="shrink-0 text-2xs text-subtle">{{ timeAgo(branch.at) }}</span>
                            </button>
                            <!-- Only a local branch can be deleted here; a remote one belongs to somebody else's repository. -->
                            <button
                                v-if="branch.local && !branch.local.current"
                                type="button"
                                :class="
                                    ui.iconButton(
                                        `h-5 w-5 rounded opacity-0 hover:text-danger focus-visible:opacity-100 group-hover/row:opacity-100`,
                                        armedDelete === branch.name ? `text-danger opacity-100` : ``,
                                    )
                                "
                                :disabled="busy"
                                @click="askDelete(branch.name)"
                                v-tooltip.top="'Delete branch'"
                                aria-label="Delete branch"
                            >
                                <Icon name="trash" class="text-2xs" />
                            </button>
                        </div>
                        <div v-if="armedDelete === branch.name" class="flex items-center gap-2 px-1.5 pb-1">
                            <span class="flex-1 text-2xs text-warning">
                                {{ forceFor === branch.name ? "Unmerged, force delete?" : `Delete ${branch.name}?` }}
                            </span>
                            <button type="button" class="text-2xs text-muted hover:text-content" @click="armedDelete = undefined">Cancel</button>
                            <Button size="small" severity="danger" :disabled="busy" @click="() => confirmDelete(branch.name)">
                                {{ forceFor === branch.name ? "Force delete" : "Delete" }}
                            </Button>
                        </div>
                    </template>
                    <p v-if="shown.length === 0" class="px-1.5 py-2 text-2xs text-subtle">No branches match.</p>
                </div>

                <div class="border-t border-line-subtle pt-1.5">
                    <button
                        v-if="!creating"
                        type="button"
                        class="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted transition-colors hover:bg-overlay hover:text-content"
                        @click="creating = true"
                    >
                        <Icon name="plus" class="text-2xs" />
                        New branch from here
                    </button>
                    <div v-else class="flex items-center gap-1.5">
                        <input
                            v-model="newName"
                            type="text"
                            placeholder="branch-name"
                            autofocus
                            class="ui-field-box ui-field-sm min-w-0 flex-1"
                            @keydown.enter="submitCreate"
                            @keydown.escape="creating = false"
                        />
                        <Button size="small" severity="secondary" :disabled="busy || newName.trim() === ''" @click="submitCreate"> Create </Button>
                    </div>
                </div>
            </div>
        </Popover>
    </div>
</template>
