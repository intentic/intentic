<script setup lang="ts">
import { cmp, Segmented } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import type { PersonaGrantable, PersonaPowersDraft } from "../../composables/sandbox/personaCard";

/* WHAT A PERSONA MAY DO — the shelves, and the per-id grants under them. Its own component because two surfaces
 * ask this exact question and neither is allowed to answer it differently: the full editor on the Personas page,
 * and the Advanced section of the quick panel behind a directory row's persona icon in the Workspace tree.
 *
 * These switches are the one part of a card where a copy that drifts is a SECURITY surprise rather than a cosmetic
 * one — a surface missing a shelf silently grants it, and the reader has no way to see the difference. So the list
 * of shelves, the wording of each consequence, and the caveat about the shell all live here once.
 *
 * The draft is the parent's, mutated in place — same contract as <PersonaForm>, for the same reason: the parent
 * owns the whole card and has to read these fields back to decide whether anything was bounded at all. */

const {
    draft,
    grantables,
    folderBound = false,
} = defineProps<{
    draft: PersonaPowersDraft;
    /** The connectors, computers and MCP connections this sandbox has, for the per-id grants. */
    grantables: readonly PersonaGrantable[];
    /** Whether the parent's form has ALSO fenced this card to a set of folders — the shell caveat's third case. */
    folderBound?: boolean;
}>();

const FILE_ACCESS = [
    { label: `None`, value: `none` as const },
    { label: `Read`, value: `read` as const },
    { label: `Read & change`, value: `write` as const },
];

/* THE SWITCHES, WITH THE CONSEQUENCE OF TURNING EACH OFF WRITTEN NEXT TO IT. A row that says only "Run
 * commands" makes the reader guess whether tests still run; saying what goes away is the difference between a
 * setting somebody sets and one they leave alone because they cannot predict it. */
const SHELVES = [
    { key: `shell` as const, label: `Run commands`, hint: `Shell, tests, builds, and every CLI on the image.` },
    { key: `web` as const, label: `Read the web`, hint: `Fetch a page, run a search.` },
    // Says what it is NOT rather than pointing at the account picker: this component renders in the quick panel
    // too, which has no picker, and "the list above" was then a reference to nothing.
    { key: `browser` as const, label: `Drive a browser`, hint: `The anonymous browser, not the signed-in accounts.` },
    { key: `delegate` as const, label: `Delegate`, hint: `Spawn sub-agents and run workflows.` },
    { key: `sandbox` as const, label: `Change the sandbox`, hint: `Its own settings and manifests, and the folder that publishes files publicly.` },
];

const GRANT_GROUPS = [
    { key: `connectors` as const, kind: `cli` as const, label: `Connectors`, empty: `No connectors added yet.` },
    { key: `computers` as const, kind: `host` as const, label: `Your computers`, empty: `No computers connected yet.` },
    { key: `mcp` as const, kind: `mcp` as const, label: `MCP connections`, empty: `No MCP connections added yet.` },
];

const groupItems = (kind: PersonaGrantable[`kind`]): PersonaGrantable[] => grantables.filter((entry) => entry.kind === kind);

// `undefined` is "every one of them", so an unset group reads as all-picked — including anything connected
// later, which is what the tri-state buys and what a materialised list of today's ids would silently lose.
const grantsAll = (key: `connectors` | `computers` | `mcp`): boolean => draft[key] === undefined;
const granted = (key: `connectors` | `computers` | `mcp`, id: string): boolean => draft[key]?.includes(id) ?? true;
const toggleGrant = (key: `connectors` | `computers` | `mcp`, id: string, kind: PersonaGrantable[`kind`]): void => {
    // The first click off "all" has to materialise the list before it can remove one from it.
    const current = draft[key] ?? groupItems(kind).map((entry) => entry.id);
    draft[key] = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
};
const setGrantsAll = (key: `connectors` | `computers` | `mcp`, all: boolean): void => {
    draft[key] = all ? undefined : [];
};

/* WHY THE SHELL SWITCH GETS A SENTENCE NOBODY ELSE GETS. A session with a shell can read a credential this card
 * never granted it, so every limit below it is a strong default rather than a wall. Saying that AT the switch is
 * the whole point — a limit that is weaker than it looks is worse than no limit, and the person setting it is
 * the only one who can decide whether that trade is fine for this persona. Raised by any bound the shell can
 * walk around, which is every per-id grant and the folder fence the parent may have set. */
const shellCaveat = computed(
    () => draft.shell && (draft.connectors !== undefined || draft.computers !== undefined || draft.mcp !== undefined || folderBound),
);
</script>

<template>
    <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2.5">
            <span class="w-36 shrink-0 text-sm text-content">Workspace files</span>
            <Segmented v-model="draft.files" :options="FILE_ACCESS" />
        </div>

        <label v-for="shelf in SHELVES" :key="shelf.key" class="flex items-center gap-2.5">
            <span class="w-36 shrink-0 text-sm text-content">{{ shelf.label }}</span>
            <ToggleSwitch v-model="draft[shelf.key]" />
            <span class="min-w-0 text-xs text-subtle">{{ shelf.hint }}</span>
        </label>

        <!-- The one caveat this form owes the reader, and only when it is actually load-bearing: a card
             that has bounded something WHILE leaving the shell on. Silent otherwise, because a full-powers
             card has nothing to be misled about. -->
        <p v-if="shellCaveat" :class="cmp.alertWarning('flex items-start gap-2 text-xs')">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />
            <span>
                With <strong>Run commands</strong> on, the limits below it are a strong default rather than a wall — a session with a shell can reach
                a credential this card didn't grant. Turn it off for a persona that has to be fenced in.
            </span>
        </p>

        <!-- The per-id grants. Collapsed to one line while a group is set to everything, which is the
             default and the answer most cards keep: a wall of checkboxes for a question nobody asked would
             bury the switches above that people do come here to set. -->
        <div v-for="group in GRANT_GROUPS" :key="group.key" class="flex flex-col gap-1.5">
            <label class="flex items-center gap-2.5">
                <span class="w-36 shrink-0 text-sm text-content">{{ group.label }}</span>
                <ToggleSwitch
                    :model-value="grantsAll(group.key)"
                    :disabled="groupItems(group.kind).length === 0"
                    @update:model-value="setGrantsAll(group.key, $event as boolean)"
                />
                <span class="min-w-0 text-xs text-subtle">
                    {{
                        groupItems(group.kind).length === 0 ? group.empty : grantsAll(group.key) ? `All of them, including new ones.` : `Pick which:`
                    }}
                </span>
            </label>
            <div v-if="!grantsAll(group.key) && groupItems(group.kind).length > 0" class="flex flex-wrap gap-2 pl-[9.5rem]">
                <button
                    v-for="item in groupItems(group.kind)"
                    :key="item.id"
                    type="button"
                    :aria-pressed="granted(group.key, item.id)"
                    :class="[
                        `cursor-pointer rounded-lg border px-2.5 py-1 text-xs transition-colors`,
                        granted(group.key, item.id)
                            ? `border-link bg-link/10 font-medium text-content`
                            : `border-line text-muted hover:border-line-strong hover:bg-overlay`,
                    ]"
                    @click="toggleGrant(group.key, item.id, group.kind)"
                >
                    {{ item.label }}
                </button>
            </div>
        </div>
    </div>
</template>
