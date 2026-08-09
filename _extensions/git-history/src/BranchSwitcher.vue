<script setup lang="ts">
import { Icon, Popover, timeAgo } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { useBranches } from "./useBranches.js";

/* The graph header's branch control: the checked-out branch as a pill, and a popover to switch, create or
 * delete. Deliberately not a bare `<select>` — a branch row carries more than a name (its upstream, how far
 * ahead/behind it is, whether that upstream is gone), and the destructive verb needs a confirm step a native
 * select can't host.
 *
 * Everything here is one composable call away from git; this component owns only the popover's local state. */

const { repo } = defineProps<{ repo: string }>();
const repoRef = computed(() => repo);
const { groups, current, busy, actionError, checkout, create, remove } = useBranches(repoRef);

const popover = ref<InstanceType<typeof Popover>>();
const filter = ref(``);
const creating = ref(false);
const newName = ref(``);
// Two-step delete, matching the Changes panel's discard: the first click arms one branch, the second runs it.
const armedDelete = ref<string | undefined>(undefined);
// A branch git refused to delete because its commits are unmerged — the force retry is offered only after
// git itself has said no, never up front.
const forceFor = ref<string | undefined>(undefined);

/* The filter matches the group's shared name, so typing "main" keeps the row that is `main` locally and
 * `origin/main` on two remotes — one row, not three. Already ordered (current first, then newest tip) by
 * groupBranches, so nothing here re-sorts. */
const shown = computed(() => {
    const needle = filter.value.trim().toLowerCase();
    return needle === `` ? groups.value : groups.value.filter((group) => group.name.toLowerCase().includes(needle));
});

/* CHECKING OUT A REMOTE-ONLY BRANCH creates the local branch that tracks it, which is what `git checkout <name>`
 * does on its own when exactly one remote has that name — so the same verb serves both rows and the reader does
 * not have to know which case they are in. */
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
    // From HEAD, and switch to it — "new branch from here", the gesture people actually mean.
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
    // git refused (unmerged commits) — offer the deliberate force retry on this branch only.
    forceFor.value = name;
};
</script>

<template>
    <div class="flex min-w-0 items-center">
        <button
            type="button"
            class="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-subtle transition-colors hover:bg-overlay hover:text-content"
            v-tooltip.bottom="'Switch, create or delete a branch'"
            aria-label="Branch"
            @click="toggle"
        >
            <Icon name="code" class="shrink-0 text-[0.6rem]" />
            <span class="truncate">{{ current?.name ?? "detached" }}</span>
            <span v-if="current && current.behind > 0" class="shrink-0 text-muted">↓{{ current.behind }}</span>
            <span v-if="current && current.ahead > 0" class="shrink-0 text-muted">↑{{ current.ahead }}</span>
            <Icon name="chevron-down" class="shrink-0 text-[0.5rem]" />
        </button>

        <Popover ref="popover">
            <div class="flex w-72 flex-col gap-1.5">
                <input
                    v-model="filter"
                    type="text"
                    placeholder="Filter branches…"
                    class="w-full rounded-md border border-line bg-canvas px-2 py-1 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                />

                <p v-if="actionError" class="truncate text-2xs text-danger" v-tooltip.bottom.overflow="actionError">{{ actionError }}</p>

                <div class="scrollbar-thin flex max-h-64 flex-col overflow-auto">
                    <!-- ONE ROW PER LINE OF WORK. `main` and `origin/main` are the same branch seen from two
                         places, so they share a row: the name once, and the remotes it also lives on as small
                         pills after it. A row with no local branch is one somebody else pushed. -->
                    <template v-for="branch in shown" :key="branch.name">
                        <div class="group/branch flex items-center gap-1 rounded transition-colors hover:bg-overlay">
                            <button
                                type="button"
                                class="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left"
                                :disabled="busy"
                                @click="pick(branch.name)"
                            >
                                <Icon
                                    :name="branch.local?.current ? 'check' : branch.local ? 'code' : 'cloud'"
                                    class="shrink-0 text-[0.6rem]"
                                    :class="branch.local?.current ? 'text-success' : 'text-subtle'"
                                />
                                <span class="min-w-0 flex-1 truncate text-xs" :class="branch.local?.current ? 'text-content' : 'text-muted'">{{
                                    branch.name
                                }}</span>
                                <!-- Which remotes also have it. Named rather than counted, because "it is on
                                     origin" and "it is on my fork" are different facts. -->
                                <span
                                    v-for="entry in branch.remotes"
                                    :key="entry.name"
                                    class="shrink-0 rounded bg-overlay px-1 text-[0.6rem] text-subtle"
                                    v-tooltip.top="entry.name"
                                    >{{ entry.remote }}</span
                                >
                                <!-- "gone" is not the same as "no upstream": the branch WAS tracking something
                                     that has since been deleted on the remote, which is the usual sign a PR
                                     merged and this local copy is safe to drop. -->
                                <span v-if="branch.local?.gone" class="shrink-0 text-2xs text-warning" v-tooltip.top="'Upstream branch was deleted'"
                                    >gone</span
                                >
                                <span v-if="(branch.local?.behind ?? 0) > 0" class="shrink-0 text-2xs text-subtle">↓{{ branch.local!.behind }}</span>
                                <span v-if="(branch.local?.ahead ?? 0) > 0" class="shrink-0 text-2xs text-subtle">↑{{ branch.local!.ahead }}</span>
                                <span class="shrink-0 text-2xs text-subtle">{{ timeAgo(branch.at) }}</span>
                            </button>
                            <!-- Only a LOCAL branch can be deleted here: dropping a remote one is somebody
                                 else's repository, and a different confirmation entirely. -->
                            <button
                                v-if="branch.local && !branch.local.current"
                                type="button"
                                class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-colors hover:bg-overlay hover:text-danger focus-visible:opacity-100 group-hover/branch:opacity-100"
                                :class="{ 'text-danger opacity-100': armedDelete === branch.name }"
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
                                {{ forceFor === branch.name ? "Unmerged — force delete?" : `Delete ${branch.name}?` }}
                            </span>
                            <button type="button" class="text-2xs text-muted hover:text-content" @click="armedDelete = undefined">Cancel</button>
                            <button
                                type="button"
                                class="rounded border border-danger/50 px-1.5 py-0.5 text-2xs text-danger transition-colors hover:bg-danger/10"
                                :disabled="busy"
                                @click="confirmDelete(branch.name)"
                            >
                                {{ forceFor === branch.name ? "Force delete" : "Delete" }}
                            </button>
                        </div>
                    </template>
                    <p v-if="shown.length === 0" class="px-1.5 py-2 text-2xs text-subtle">No branches match.</p>
                </div>

                <div class="border-t border-line pt-1.5">
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
                            class="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                            @keydown.enter="submitCreate"
                            @keydown.escape="creating = false"
                        />
                        <button
                            type="button"
                            class="rounded border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40"
                            :disabled="busy || newName.trim() === ''"
                            @click="submitCreate"
                        >
                            Create
                        </button>
                    </div>
                </div>
            </div>
        </Popover>
    </div>
</template>
