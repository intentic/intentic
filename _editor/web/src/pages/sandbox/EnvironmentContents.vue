<script setup lang="ts">
import type { EnvironmentItem } from "@intentic-app/api-contract";
import { Code, Notice, Row, RowGroup, cmp } from "@intentic/ui";
import { ref } from "vue";
import type { ContentsGroup } from "../../composables/sandbox/useEnvironmentContents";

/* THE SANDBOX AS CONTENTS rather than as a build recipe — the answer to "what can this thing do?", which is what
 * people actually open the Environment tab for. The recipe stays one pill away for whoever wants to see exactly
 * what runs.
 *
 * ROWS, NOT A TILE GRID. Each entry is a name, a version and a sentence, and a sentence wants horizontal room:
 * tiles truncate it and go ragged, and the explanations behind these entries run from one line to twenty. Rows
 * take the width the card was wasting, and the icon plus version chips do the at-a-glance work a grid of logos
 * would — "Rust, ffmpeg, Docker" is legible from the left edge alone.
 *
 * AND THE EXPLANATION IS NOT HOVER-ONLY. Hover was the obvious way to hang these rationales off a compact view
 * and it is the wrong one: it does not exist on a touch screen, it is awkward from the keyboard, and a
 * twenty-line box that vanishes when the pointer crosses a gap is not a place anybody reads. So the row's face
 * always carries the part everyone reads — name, version, one line — with no interaction at all, and a click
 * opens the rest in place. Hover stays what it is good for: the title on a chip whose text had to be cut.
 */

const { groups, awaiting, loading, error } = defineProps<{
    groups: ContentsGroup[];
    awaiting: number;
    loading: boolean;
    error?: string;
}>();

// Which rows are open. Ids, not a flag per item, so the set survives a refetch replacing the objects.
const open = ref(new Set<string>());
const toggle = (id: string): void => {
    const next = new Set(open.value);
    if (!next.delete(id)) {
        next.add(id);
    }
    open.value = next;
};

/* The staples group starts closed. It is long, it is the same on every sandbox, and it is nobody's decision —
 * useful as an answer to "is Python in here?" and noise above the two groups that are about THIS workspace. */
const collapsed = ref(new Set<string>([`base`]));
const toggleGroup = (origin: string): void => {
    const next = new Set(collapsed.value);
    if (!next.delete(origin)) {
        next.add(origin);
    }
    collapsed.value = next;
};

// At most three version chips on a row; a toolchain installs more commands than a row can carry, and the rest
// are in the expansion. Three because it is what fits beside the longest names at the narrowest width.
const CHIP_LIMIT = 3;
const chips = (item: EnvironmentItem): EnvironmentItem[`tools`] => item.tools.slice(0, CHIP_LIMIT);

/* A single-tool row is usually NAMED after its tool ("ffmpeg", "bun"), and printing that name twice on one line
 * — once as the title, once on the chip beside it — reads as a rendering bug. So the chip drops to the bare
 * version there, and keeps its name wherever the row installs more than its own namesake. */
const chipLabel = (item: EnvironmentItem, tool: EnvironmentItem[`tools`][number]): string =>
    item.tools.length === 1 && tool.name.toLowerCase() === item.name.toLowerCase() ? `` : tool.name;

/* WHAT THE ROW SAYS ABOUT ITS OWN STATE, and only when there is something to say. An `active` item gets no
 * badge at all — the whole list is things the sandbox has, so marking the normal case would put a green tick on
 * every line and leave the two that matter no louder than the rest. */
const STATES = {
    active: undefined,
    "after-rebuild": { icon: `clock`, label: `arrives after rebuild`, tone: `text-warning` },
    "awaiting-approval": { icon: `sparkles`, label: `waiting for your approval`, tone: `text-link` },
} as const;
const stateOf = (item: EnvironmentItem) => STATES[item.state];

// The count a group's header carries. "3 items" rather than a bare number, because the number sits next to
// version numbers and a lone "3" beside "1.90.0" reads as one more of them.
const countLabel = (group: ContentsGroup): string => `${group.items.length} ${group.items.length === 1 ? `item` : `items`}`;
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- Said once, above everything, because it is the sentence that makes the rest trustworthy: these
             versions are what the tools report, not what the recipe asked for. -->
        <p v-if="groups.length > 0" class="text-2xs text-subtle">
            Versions are read from the tools themselves, so this is what the sandbox has right now — not what the recipe asks for.
            <template v-if="awaiting > 0">
                {{ awaiting === 1 ? `One entry is` : `${awaiting} entries are` }} waiting for your approval and not installed yet.
            </template>
        </p>

        <RowGroup v-for="group in groups" :key="group.origin" :label="group.label" :count="countLabel(group)">
            <template #actions>
                <button type="button" class="cursor-pointer text-2xs font-medium text-muted hover:text-content" @click="toggleGroup(group.origin)">
                    {{ collapsed.has(group.origin) ? `Show` : `Hide` }}
                </button>
            </template>
            <template v-if="!collapsed.has(group.origin)">
                <Row
                    v-for="item in group.items"
                    :key="item.id"
                    density="compact"
                    icon="box"
                    :title="item.name"
                    :description="item.purpose"
                    :interactive="item.detail !== undefined || item.commands !== undefined"
                    :class="item.state === `after-rebuild` ? `opacity-70` : undefined"
                    @click="(item.detail !== undefined || item.commands !== undefined) && toggle(item.id)"
                >
                    <!-- THE VERSIONS RIDE THE NAME, not the row's right edge. They are what the name is a version
                         OF, so they belong beside it — and the trailing #meta cluster does not shrink, so four
                         chips out there squeezed the sentence below into one word per line. Here they wrap. -->
                    <template #title>
                        <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span>{{ item.name }}</span>
                            <span
                                v-for="tool in chips(item)"
                                :key="tool.name"
                                class="inline-flex items-baseline gap-1 rounded-full bg-overlay px-1.5 py-0.5 font-mono text-2xs font-normal"
                            >
                                <span v-if="chipLabel(item, tool) !== ``" class="text-content">{{ chipLabel(item, tool) }}</span>
                                <span v-if="tool.version !== undefined" class="text-muted">{{ tool.version }}</span>
                                <span v-else-if="chipLabel(item, tool) === ``" class="text-subtle">installed</span>
                            </span>
                            <span
                                v-if="item.tools.length > CHIP_LIMIT"
                                v-tooltip.bottom="item.tools.map((tool) => tool.name).join(`, `)"
                                class="text-2xs font-normal text-subtle"
                            >
                                +{{ item.tools.length - CHIP_LIMIT }} more
                            </span>
                            <span
                                v-if="item.extras !== undefined"
                                v-tooltip.bottom="`Libraries and headers these commands need, which nobody runs directly`"
                                class="text-2xs font-normal text-subtle"
                            >
                                +{{ item.extras }} packages
                            </span>
                        </span>
                    </template>
                    <!-- Only what the row is worth interrupting for: what pulled the thing in, and the two states
                         that are not simply "it is here". -->
                    <template #meta>
                        <span v-if="item.originLabel !== undefined" class="hidden sm:inline">{{ item.originLabel }}</span>
                        <span v-if="stateOf(item) !== undefined" :class="stateOf(item)?.tone" class="inline-flex items-center gap-1 font-medium">
                            <Icon :name="stateOf(item)!.icon" />{{ stateOf(item)!.label }}
                        </span>
                    </template>
                    <template #below>
                        <div v-if="open.has(item.id)" class="flex flex-col gap-3">
                            <!-- The rest of what the agent wrote, as prose. Its own paragraphs, its own bullet
                                 lists — it was written to be read, and rendering it as code would undo that. -->
                            <p v-if="item.detail !== undefined" class="whitespace-pre-line text-xs leading-relaxed text-muted">
                                {{ item.detail }}
                            </p>
                            <Code v-if="item.commands !== undefined" :code="item.commands" lang="docker" label="What this installs" />
                        </div>
                    </template>
                </Row>
            </template>
        </RowGroup>

        <!-- Three different sentences, and telling them apart matters: still asking, could not ask, and asked and
             there is genuinely nothing. The middle one is why the failure is not silently drawn as the last. -->
        <div v-if="loading" :class="cmp.emptyState(`py-8`)"><Icon name="spinner" class="mr-1.5 animate-spin" />Asking the sandbox what it has…</div>
        <Notice v-else-if="error !== undefined" :of="{ tone: `warning`, title: `Could not read what the sandbox has installed.`, detail: error }" />
        <div v-else-if="groups.length === 0" :class="cmp.emptyState(`py-8`)">
            Nothing added on top of the stock image yet — and nothing in it answered, which usually means the sandbox is still starting.
        </div>
    </div>
</template>
