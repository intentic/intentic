<script setup lang="ts">
import { ui, Notice, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import type { PersonaGrantable, PersonaPowersDraft } from "./personaCard";

// What a persona may do: shelves plus per-id grants, one component since two surfaces (the editor, the quick panel)
// must never answer this differently. Split by blast radius, workspace then reach beyond it, everything visible: a
// permission you can't see is one you can't audit. The draft is the parent's, mutated in place, like <PersonaForm>.

const {
    draft,
    grantables,
    folderBound = false,
} = defineProps<{
    draft: PersonaPowersDraft;
    /** The connectors, devices and MCP connections this sandbox has, for the per-id grants. */
    grantables: readonly PersonaGrantable[];
    /** Whether the parent's form has also fenced this card to a set of folders: the shell caveat's third case. */
    folderBound?: boolean;
}>();

const FILE_ACCESS = [
    { label: `None`, value: `none` as const },
    { label: `Read`, value: `read` as const },
    { label: `Read & change`, value: `write` as const },
];

// Rail width and hint indent live here once, so no row's hint can drift from under its own label.
const RAIL = `w-4 shrink-0 text-center text-xs text-subtle`;
const HINT = `pl-6 text-xs text-subtle`;

// Each switch states the consequence of turning it off, so the choice isn't a guess about what stops working.

// What it can do to the workspace itself; files leads since it's the widest and most common change, and sandbox
// settings/outbox are workspace files too.
const WORKSPACE_SHELVES = [
    {
        key: `sandbox` as const,
        icon: `cog` as const,
        label: `Change the sandbox`,
        hint: `Its own settings and manifests, and the folder that publishes files publicly.`,
    },
];

// What it can reach past the workspace. Shell heads this group, not the one above, since a command can post, fetch,
// install and read a credential, the only sentence on this card in a warning tone is the caveat about it.
const OUTWARD_SHELVES = [
    { key: `shell` as const, icon: `terminal` as const, label: `Run commands`, hint: `Shell, tests, builds, and every CLI on the image.` },
    // Sits under Run commands since they answer the same question (what may a session run); fenced to the Files answer,
    // and can't start programs without Run commands.
    {
        key: `code` as const,
        icon: `code` as const,
        label: `Run code`,
        hint: `JavaScript runs fenced by the runtime: files follow the Files answer, no programs without Run commands.`,
    },
    // Reuses the globe an accountless browser site also wears (useBrowserAccounts); told apart by treatment, not a
    // different glyph, since the mark must stay one per account everywhere.
    { key: `web` as const, icon: `globe` as const, label: `Read the web`, hint: `Fetch a page, run a search.` },
    // States what it isn't rather than pointing at the account picker, since this component also renders in the quick
    // panel, which has none.
    // `picture-in-picture`: `window-maximize` (the first guess) read as "make this bigger", not "drive a browser".
    {
        key: `browser` as const,
        icon: `picture-in-picture` as const,
        label: `Drive a browser`,
        hint: `The anonymous browser, not the signed-in accounts.`,
    },
    // A branching hierarchy, since delegating creates one; a group-of-people glyph read as "several people", not
    // "several agents".
    { key: `delegate` as const, icon: `sitemap` as const, label: `Delegate`, hint: `Spawn sub-agents and run workflows.` },
];

const GRANT_GROUPS = [
    // `link`, not a wrench, since the reader maps the glyph to the label beside it (Connectors).
    { key: `connectors` as const, kind: `cli` as const, icon: `link` as const, label: `Connectors`, empty: `No connectors added yet.` },
    {
        key: `devices` as const,
        kind: `host` as const,
        icon: `desktop` as const,
        label: `Your devices`,
        empty: `No devices connected yet.`,
    },
    { key: `mcp` as const, kind: `mcp` as const, icon: `server` as const, label: `MCP connections`, empty: `No MCP connections added yet.` },
];

const groupItems = (kind: PersonaGrantable[`kind`]): PersonaGrantable[] => grantables.filter((entry) => entry.kind === kind);

// undefined means every one of them, including anything connected later; a materialised list of today's ids would
// silently lose that.
const grantsAll = (key: `connectors` | `devices` | `mcp`): boolean => draft[key] === undefined;
const granted = (key: `connectors` | `devices` | `mcp`, id: string): boolean => draft[key]?.includes(id) ?? true;
const toggleGrant = (key: `connectors` | `devices` | `mcp`, id: string, kind: PersonaGrantable[`kind`]): void => {
    // The first click off "all" has to materialise the list before removing one from it.
    const current = draft[key] ?? groupItems(kind).map((entry) => entry.id);
    draft[key] = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
};
const setGrantsAll = (key: `connectors` | `devices` | `mcp`, all: boolean): void => {
    draft[key] = all ? undefined : [];
};

// A shell can read a credential no other switch granted, so every limit below it is a default, not a wall, said at the
// switch since only the person setting it can judge that trade. Raised by any bound the shell can walk around.
const shellCaveat = computed(
    () => draft.shell && (draft.connectors !== undefined || draft.devices !== undefined || draft.mcp !== undefined || folderBound),
);
</script>

<template>
    <div class="@container">
        <!--
            Folds at @2xl, not higher: a rem threshold reads about 10% wider than this app's 17.6px root font, and @3xl kept an opened card
            single-column below ~1100px.
        -->
        <div class="grid items-start gap-x-10 gap-y-6 @2xl:grid-cols-2">
            <!--
                What changes what this box holds, then where in it the card may stand; location fields arrive through the slot, since only the
                editor, not the quick panel, has them.
            -->
            <div class="flex flex-col gap-6">
                <div class="flex flex-col gap-3">
                    <span :class="ui.sectionLabel()">In your workspace</span>

                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Icon name="file-tree" :class="RAIL" />
                        <span class="min-w-0 flex-1 text-sm text-content">Files</span>
                        <SegmentedControl v-model="draft.files" :options="FILE_ACCESS" />
                    </div>

                    <label v-for="shelf in WORKSPACE_SHELVES" :key="shelf.key" class="flex flex-col gap-0.5">
                        <span class="flex items-center gap-2">
                            <Icon :name="shelf.icon" :class="RAIL" />
                            <span class="min-w-0 flex-1 text-sm text-content">{{ shelf.label }}</span>
                            <ToggleSwitch v-model="draft[shelf.key]" />
                        </span>
                        <span :class="HINT">{{ shelf.hint }}</span>
                    </label>
                </div>

                <!-- The rail goes out with the slot, so whatever the parent renders there lines up with the rows above it. -->
                <slot name="where" :rail="RAIL" />
            </div>

            <!-- Everything whose consequences leave this box. -->
            <div class="flex flex-col gap-3">
                <span :class="ui.sectionLabel()">Reaching out</span>

                <label v-for="shelf in OUTWARD_SHELVES" :key="shelf.key" class="flex flex-col gap-0.5">
                    <span class="flex items-center gap-2">
                        <Icon :name="shelf.icon" :class="RAIL" />
                        <span class="min-w-0 flex-1 text-sm text-content">{{ shelf.label }}</span>
                        <ToggleSwitch v-model="draft[shelf.key]" />
                    </span>
                    <span :class="HINT">{{ shelf.hint }}</span>
                </label>

                <!--
                    Shown only when it's load-bearing: something is bounded while the shell stays on. Silent otherwise, since a full-powers card has
                    nothing to be misled about.
                -->
                <Notice v-if="shellCaveat" tone="warning">
                    With <strong>Run commands</strong> on, every other limit on this card is a strong default rather than a wall: a session with a
                    shell can reach a credential it wasn't granted. Turn it off for a persona that has to be fenced in.
                </Notice>

                <!--
                    Collapsed to one line while a group is set to everything (the default), so a checkbox wall for a question nobody asked doesn't
                    bury the switches above.
                -->
                <div v-for="group in GRANT_GROUPS" :key="group.key" class="flex flex-col gap-1.5">
                    <label class="flex flex-col gap-0.5">
                        <span class="flex items-center gap-2">
                            <Icon :name="group.icon" :class="RAIL" />
                            <span class="min-w-0 flex-1 text-sm text-content">{{ group.label }}</span>
                            <ToggleSwitch
                                :model-value="grantsAll(group.key)"
                                :disabled="groupItems(group.kind).length === 0"
                                @update:model-value="setGrantsAll(group.key, $event as boolean)"
                            />
                        </span>
                        <span :class="HINT">
                            {{
                                groupItems(group.kind).length === 0
                                    ? group.empty
                                    : grantsAll(group.key)
                                      ? `All of them, including new ones.`
                                      : `Pick which:`
                            }}
                        </span>
                    </label>
                    <!--
                        Indented to the label, not a vanished label column, so the chips read as that row's answer; kept outside the <label> so a
                        chip click doesn't toggle the group off.
                    -->
                    <div v-if="!grantsAll(group.key) && groupItems(group.kind).length > 0" class="flex flex-wrap gap-2 pl-6">
                        <button
                            v-for="item in groupItems(group.kind)"
                            :key="item.id"
                            type="button"
                            :aria-pressed="granted(group.key, item.id)"
                            :class="[`ui-chip px-2.5 py-1 text-xs`, granted(group.key, item.id) ? `ui-chip-on font-medium` : ``]"
                            @click="toggleGrant(group.key, item.id, group.kind)"
                        >
                            {{ item.label }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
