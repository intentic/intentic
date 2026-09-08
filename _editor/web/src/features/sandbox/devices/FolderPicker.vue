<script setup lang="ts">
import type { WorkspaceChildrenResponse, WorkspaceTreeEntry, WorkspaceTreeResponse } from "@intentic/api-contract";
import { ui, ResponsiveOverlay, SkeletonRows, vAction } from "@intentic/ui";
import { computed, ref, shallowRef } from "vue";
import { WORKSPACE_TREE } from "../../../lib/queryKeys";
import { sandboxJson } from "../client/sandboxClient";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Folder picker as a tree, not a text field, so a typo can't fence a persona to a nonexistent folder.
// Directories only; ignored ones (node_modules, .git, gitignored) are excluded. Shows what is stored, not what
// resolves — an absent folder keeps its chip — and keeps its own expansion state, separate from the explorer's.

const {
    multiple = false,
    placeholder,
    label,
} = defineProps<{
    /** Several folders (a fence), or exactly one (where a session starts). */
    multiple?: boolean;
    /** What no selection means; never "pick something" — empty is a valid, common answer. */
    placeholder: string;
    /** Names the trigger for a screen reader; the visible label is the form row's. */
    label: string;
}>();

const picked = defineModel<string[]>({ required: true });

// Shared workspace tree, keyed like the explorer's read so opening this picker after the tree has drawn costs
// nothing. Not scoped via scopeQuery: folders are workspace-relative regardless of which checkout is active.
const { query } = useSandboxQuery<WorkspaceTreeResponse>({
    queryKey: WORKSPACE_TREE.of(`shared`),
    queryFn: () => sandboxJson<WorkspaceTreeResponse>(`/workspace/tree`),
});

// Sandbox-scoped like other reads behind these panels, so switching sandboxes drops the outline.
const outline = useSandboxOutline(query.isPending);

// Only directories, and only non-ignored ones (node_modules, .git, gitignored).
const foldersIn = (entries: readonly WorkspaceTreeEntry[]): readonly WorkspaceTreeEntry[] =>
    entries.filter((entry) => entry.type === `dir` && entry.ignored !== true);

const roots = computed(() => foldersIn(query.data.value?.tree ?? []));

// Children for dirs past the daemon's breadth-first budget. `shallowRef`: the map is replaced wholesale, never
// mutated in place.
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
        // A folder that won't list isn't worth a banner here: it simply stops offering to expand.
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

// Visible rows flattened with depth, rather than a self-recursing component: one list for keyboard and scroll,
// and depth becomes an indent.
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

// Undefined children means not loaded yet; treated as openable until proven empty.
const openable = (entry: WorkspaceTreeEntry): boolean => {
    const listed = childrenOf(entry);
    return listed === undefined || listed.length > 0;
};

const isPicked = (path: string): boolean => picked.value.includes(path);

const open = ref(false);
const anchor = ref<HTMLElement | undefined>(undefined);

const choose = (path: string): void => {
    if (!multiple) {
        // Picking answers a single-folder question, so the panel closes; picking the current folder clears it instead.
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
        <!-- Picked folders sit in the trigger as removable chips, so seeing and dropping one never opens the tree. -->
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

        <!--
            Opens downward rather than the overlay's own default (above), which would land the tree over the field's own
            section heading. Still flips up if the window is too short.
        -->
        <ResponsiveOverlay v-model="open" :anchor="anchor" side="bottom" header="Choose a folder" panel-class="w-80 p-1">
            <!-- Holds the panel's height steady while the tree loads, rather than jumping once rows arrive. -->
            <div v-if="query.isPending.value" role="status" aria-busy="true">
                <span class="sr-only">Reading your workspace…</span>
                <SkeletonRows v-if="outline" :rows="5" density="dense" :control="false" />
            </div>
            <div v-else-if="rows.length === 0" :class="ui.emptyState('py-4 text-xs')">No folders in this workspace yet.</div>
            <div v-else class="flex max-h-72 flex-col overflow-y-auto">
                <div v-for="row in rows" :key="row.entry.path" class="flex items-center" :style="{ paddingLeft: `${row.depth * 0.75}rem` }">
                    <!--
                        Opening and choosing are different intents, so different targets; a leaf keeps the same indent from a spacer
                        so names stay in one column.
                    -->
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
