<script setup lang="ts">
import type { WorkspaceChildrenResponse, WorkspaceTreeEntry, WorkspaceTreeResponse } from "@intentic-app/api-contract";
import { ui, ResponsiveOverlay, SkeletonRows, vAction } from "@intentic/ui";
import { computed, ref, shallowRef } from "vue";
import { WORKSPACE_TREE } from "../../composables/queryKeys";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import { useSandboxQuery } from "../../composables/sandbox/useSandboxQuery";

/* PICKING A FOLDER BY LOOKING AT THE FOLDERS: the control behind both of a persona's location questions.
 *
 * Both of them used to be a bare text input with a greyed-out sentence in it, which asks the reader to know two
 * things the screen was not telling them: what the workspace actually contains, and how this field wants a path
 * spelled. A typo produced a persona fenced to a folder that does not exist: silently, because a fence naming
 * nothing refuses everything, and the comma-separated variant made that failure mode plural.
 *
 * SO THE TREE IS THE FIELD. Directories only: this is a question about WHERE, and a file in the list is a row
 * that cannot be picked and still costs a line. Ignored ones (node_modules, .git, anything gitignored) are out
 * for the same reason: the daemon already knows which they are, nobody fences a persona to a dependency tree,
 * and on a workspace with four repos they are most of what a walk returns.
 *
 * IT SHOWS WHAT IS STORED, not what it can resolve. A card naming `app/api` keeps that chip whether or not this
 * workspace has that folder: a persona written against a repo nobody has cloned here yet is an ordinary thing,
 * and dropping the chip would quietly rewrite what the card fences the next time somebody pressed Save. Same
 * rule the account chips follow one section up, for the same reason.
 *
 * THE EXPANSION STATE IS THIS COMPONENT'S OWN, deliberately. The obvious economy is to reach for
 * useWorkspaceTree, which already walks /work, but its expanded set is the file EXPLORER's, persisted per
 * sandbox, and drilling into a folder here would silently reorganise the sidebar the user left open behind
 * this page. What is shared is the cache entry the walk lands in, which costs nothing and is the same bytes. */

const {
    multiple = false,
    placeholder,
    label,
} = defineProps<{
    /** Several folders (a fence), or exactly one (where a session starts). */
    multiple?: boolean;
    /** What no selection MEANS: never "pick something", because empty is a valid, common answer to both. */
    placeholder: string;
    /** Names the trigger for a screen reader; the visible label is the form row's. */
    label: string;
}>();

const picked = defineModel<string[]>({ required: true });

/* The shared workspace's own walk, under the key the explorer's shared-tree read uses, so opening this picker
 * on a page that has already drawn the tree costs no request at all. Pointedly NOT scoped through scopeQuery: a
 * card's folders are workspace-relative and mean the same thing in every copy, so the tree to choose them from
 * is the real one, not whichever conversation's checkout the workspace view happens to be pointed at. */
const { query } = useSandboxQuery<WorkspaceTreeResponse>({
    queryKey: WORKSPACE_TREE.of(`shared`),
    queryFn: () => sandboxJson<WorkspaceTreeResponse>(`/workspace/tree`),
});

/* Whether the wait is worth drawing. Sandbox-scoped like every other read behind these panels, so switching
 * sandboxes drops the outline rather than holding one workspace's shape over another's. */
const outline = useSandboxOutline(query.isPending);

// Only what can be picked, and only what is worth showing: see the header for why ignored dirs are out.
const foldersIn = (entries: readonly WorkspaceTreeEntry[]): readonly WorkspaceTreeEntry[] =>
    entries.filter((entry) => entry.type === `dir` && entry.ignored !== true);

const roots = computed(() => foldersIn(query.data.value?.tree ?? []));

// Children for the dirs the daemon's breadth-first budget stopped above. `shallowRef` because the map is
// replaced wholesale on every landing and its contents are never mutated in place.
const lazy = shallowRef(new Map<string, readonly WorkspaceTreeEntry[]>());
const loading = ref(new Set<string>());
const opened = ref(new Set<string>());

const childrenOf = (entry: WorkspaceTreeEntry): readonly WorkspaceTreeEntry[] | undefined => {
    const listed = entry.children ?? lazy.value.get(entry.path);
    return listed === undefined ? undefined : foldersIn(listed);
};

const load = async (path: string): Promise<void> => {
    if (lazy.value.has(path) || loading.value.has(path)) {
        return;
    }
    loading.value = new Set(loading.value).add(path);
    try {
        const body = await sandboxJson<WorkspaceChildrenResponse>(`/workspace/children?${new URLSearchParams({ path }).toString()}`);
        lazy.value = new Map(lazy.value).set(path, body.entries);
    } catch {
        /* A folder that will not list is not an error worth a banner here: the row simply stops offering to
         * open, every other folder still picks, and the field it belongs to takes typed text besides. */
        lazy.value = new Map(lazy.value).set(path, []);
    } finally {
        const next = new Set(loading.value);
        next.delete(path);
        loading.value = next;
    }
};

const expand = async (entry: WorkspaceTreeEntry): Promise<void> => {
    const next = new Set(opened.value);
    if (next.has(entry.path)) {
        next.delete(entry.path);
        opened.value = next;
        return;
    }
    next.add(entry.path);
    opened.value = next;
    if (entry.children === undefined) {
        await load(entry.path);
    }
};

/* The visible rows, flattened with their depth rather than drawn by a component that recurses into itself. One
 * list is what the keyboard and the scroll container both want, and the nesting a reader needs is an indent. */
interface FolderRow {
    readonly entry: WorkspaceTreeEntry;
    readonly depth: number;
}
const rows = computed<readonly FolderRow[]>(() => {
    const out: FolderRow[] = [];
    const walk = (entries: readonly WorkspaceTreeEntry[], depth: number): void => {
        for (const entry of entries) {
            out.push({ entry, depth });
            if (opened.value.has(entry.path)) {
                walk(childrenOf(entry) ?? [], depth + 1);
            }
        }
    };
    walk(roots.value, 0);
    return out;
});

// A dir the walk listed as empty has nothing to open; one it never descended into might, and says so until it
// has been asked. Undefined children ⇒ not loaded yet, which is the distinction the contract keeps for this.
const openable = (entry: WorkspaceTreeEntry): boolean => {
    const listed = childrenOf(entry);
    return listed === undefined || listed.length > 0;
};

const isPicked = (path: string): boolean => picked.value.includes(path);

const open = ref(false);
const anchor = ref<HTMLElement | undefined>(undefined);

const choose = (path: string): void => {
    if (!multiple) {
        // Picking IS the answer to a single-folder question, so the panel closes on it. Clicking the folder
        // that is already picked clears back to the placeholder's meaning rather than being a no-op.
        picked.value = isPicked(path) ? [] : [path];
        open.value = false;
        return;
    }
    picked.value = isPicked(path) ? picked.value.filter((entry) => entry !== path) : [...picked.value, path];
};

const remove = (path: string): void => {
    picked.value = picked.value.filter((entry) => entry !== path);
};
</script>

<template>
    <div class="flex min-w-0 flex-1 flex-col gap-1">
        <!-- THE ANSWER IS THE CONTROL. What is chosen sits in the trigger as removable chips, so the common
             journey (see it, drop one) never opens the tree at all. -->
        <div ref="anchor" :class="ui.input('flex min-h-[2.25rem] flex-wrap items-center gap-1.5 py-1.5')" role="group" :aria-label="label">
            <button
                v-for="path in picked"
                :key="path"
                type="button"
                class="ui-chip ui-chip-on group py-0.5 pl-1.5 pr-1 text-xs hover:border-danger"
                :aria-label="`Remove ${path}`"
                @click="remove(path)"
            >
                <Icon name="folder" class="shrink-0 text-2xs text-muted" />
                <span class="truncate font-medium text-content">{{ path }}</span>
                <Icon name="times" class="shrink-0 text-2xs text-subtle group-hover:text-danger" />
            </button>

            <span v-if="picked.length === 0" class="text-sm text-subtle">{{ placeholder }}</span>

            <button
                type="button"
                :class="ui.linkButton('ml-auto h-auto shrink-0 gap-1 py-0 text-xs text-muted hover:text-content')"
                :aria-expanded="open"
                @click="open = !open"
            >
                <Icon name="folder-open" class="text-2xs" />
                {{ picked.length === 0 ? `Choose` : multiple ? `Add` : `Change` }}
            </button>
        </div>

        <!-- Drops DOWN from the field, the way a form control opens: the overlay's own default is above, which
             is right for a toolbar pill hanging off the top of a panel and wrong here: it lands the tree over
             the section heading the field belongs to. It still flips up by itself when the window is too short
             for it, which is the one case above is better. -->
        <ResponsiveOverlay v-model="open" :anchor="anchor" side="bottom" header="Choose a folder" panel-class="w-80 p-1">
            <!-- A SPINNER AND A SENTENCE where a tree goes: the panel opened at the height of one line and
                 then jumped to the height of a folder list, under a pointer already on its way to where the
                 first row was about to be. The rows that are coming hold the panel open instead. -->
            <div v-if="query.isPending.value" role="status" aria-busy="true">
                <span class="sr-only">Reading your workspace…</span>
                <SkeletonRows v-if="outline" :rows="5" density="dense" :control="false" />
            </div>
            <div v-else-if="rows.length === 0" :class="ui.emptyState('py-4 text-xs')">No folders in this workspace yet.</div>
            <div v-else class="flex max-h-72 flex-col overflow-y-auto">
                <div v-for="row in rows" :key="row.entry.path" class="flex items-center" :style="{ paddingLeft: `${row.depth * 0.75}rem` }">
                    <!-- Opening a folder and choosing it are different intents, so they are different targets.
                         A row with nothing under it keeps the same indent from a spacer, so the names stay in
                         one column instead of stepping left wherever a leaf appears. -->
                    <button
                        v-if="openable(row.entry)"
                        type="button"
                        :class="ui.iconButton('h-6 w-5')"
                        :aria-expanded="opened.has(row.entry.path)"
                        :aria-label="`${opened.has(row.entry.path) ? `Collapse` : `Expand`} ${row.entry.path}`"
                        v-action="() => expand(row.entry)"
                    >
                        <Icon
                            :name="loading.has(row.entry.path) ? `spinner` : opened.has(row.entry.path) ? `chevron-down` : `chevron-right`"
                            :spin="loading.has(row.entry.path)"
                            class="text-2xs"
                        />
                    </button>
                    <span v-else class="h-6 w-5 shrink-0" />

                    <button
                        type="button"
                        :aria-pressed="isPicked(row.entry.path)"
                        :class="[
                            `flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors`,
                            isPicked(row.entry.path) ? `bg-link/10 font-medium text-content` : `text-muted hover:bg-overlay hover:text-content`,
                        ]"
                        @click="choose(row.entry.path)"
                    >
                        <Icon :name="opened.has(row.entry.path) ? `folder-open` : `folder`" class="shrink-0 text-2xs" />
                        <span class="truncate">{{ row.entry.name }}</span>
                        <Icon v-if="isPicked(row.entry.path)" name="check" class="ml-auto shrink-0 text-2xs text-link" />
                    </button>
                </div>
            </div>
        </ResponsiveOverlay>
    </div>
</template>
