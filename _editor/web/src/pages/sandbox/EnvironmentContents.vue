<script setup lang="ts">
import type { EnvironmentItem } from "@intentic-app/api-contract";
import { BrandMark, Code, Notice, Row, RowGroup, SearchBar, cmp } from "@intentic/ui";
import { computed, ref } from "vue";
import type { ContentsGroup } from "../../composables/sandbox/useEnvironmentContents";
import { environmentVisual } from "./environmentVisual";

/* THE SANDBOX AS CONTENTS rather than as a build recipe — the answer to "what can this thing do?", which is what
 * people actually open the Environment tab for. The recipe stays one pill away for whoever wants to see exactly
 * what runs.
 *
 * TWO PRESENTATIONS, BECAUSE THE GROUPS ARE ASKED DIFFERENT QUESTIONS. What an agent added and what a capability
 * costs are DECISIONS — few, rationale attached, worth reading, and the reason someone opened this tab. What
 * ships with every sandbox is a LOOKUP: nobody reads "Git — every repo in the workspace is a real git repo",
 * they only ever ask "is Python in here?". Drawing thirteen lookups in the same reading layout as three
 * decisions is what made this tab two screens long and made the decisions the quietest thing on it. So the
 * staples are a strip of marks you scan or filter, and the rows are kept for the entries that earn them.
 *
 * ONE LINE PER ROW. The name, its versions and the sentence sit on one line and the sentence truncates, because
 * the row is a thousand pixels wide and was spending a second line on prose that had horizontal room going
 * spare. Whatever gets cut is on the row's own tooltip, and the rationale that runs to paragraphs was always
 * behind the disclosure anyway.
 *
 * AND EVERY ROW CARRIES ITS OWN MARK. This column used to draw one grey box eighteen times: it cost width and
 * said nothing, so telling ffmpeg from Bun meant reading rather than glancing. environmentVisual.ts owns which
 * mark, and the ladder inside <BrandMark> owns what happens when a brand cannot be fetched.
 *
 * THE EXPLANATION IS STILL NOT HOVER-ONLY. Hover was the obvious way to hang these rationales off a compact view
 * and it is the wrong one: it does not exist on a touch screen, it is awkward from the keyboard, and a
 * twenty-line box that vanishes when the pointer crosses a gap is not a place anybody reads. A click opens the
 * paragraph in place. Hover stays what it is good for: text that had to be cut, and the provenance of a version
 * number — a footnote read once, which used to cost three lines at the top of the tab.
 *
 * AND NOTHING IS SHOWN TWICE, WHICH TOOK BOTH SIDES. Every long entry here used to open on its own opening
 * sentence twice — once as the row's trimmed line, once as the head of the paragraph below it — because the
 * disclosure was built as "the prose minus the row's line" while the row's line is a SUMMARY of that prose
 * rather than its first instalment. The daemon now sends the paragraph whole (see detailOf) and this view shows
 * one of the two at a time; the same rule is why the row's tooltip is `.overflow` and why the strip's pills open
 * one sentence at a time.
 */

const { groups, awaiting, loading, error } = defineProps<{
    groups: ContentsGroup[];
    awaiting: number;
    loading: boolean;
    error?: string;
}>();

// Which rows are open, and which of those have been asked for the whole of their prose. Ids, not a flag per
// item, so both sets survive a refetch replacing the objects.
const open = ref(new Set<string>());
const full = ref(new Set<string>());
const flipped = (ids: Set<string>, id: string): Set<string> => {
    const next = new Set(ids);
    if (!next.delete(id)) {
        next.add(id);
    }
    return next;
};
const toggle = (id: string): void => {
    open.value = flipped(open.value, id);
};
const toggleFull = (id: string): void => {
    full.value = flipped(full.value, id);
};

/* ONE FILTER FOR THE WHOLE TAB, not one per group. "Is X installed?" does not know which group X is in — ffmpeg
 * is a workspace addition here and a staple on the next sandbox — so a filter attached to the long group would
 * answer the question wrongly rather than not at all. Groups that match nothing drop out entirely: an empty
 * bordered surface under a heading reads as "you have none of these", which would be a lie about a group the
 * query simply missed. */
const query = ref(``);
const matches = (item: EnvironmentItem, needle: string): boolean =>
    [item.name, item.purpose ?? ``, ...item.tools.map((tool) => tool.name)].some((text) => text.toLowerCase().includes(needle));
const shown = computed((): ContentsGroup[] => {
    const needle = query.value.trim().toLowerCase();
    if (needle === ``) {
        return groups;
    }
    return groups
        .map((group) => ({ origin: group.origin, label: group.label, items: group.items.filter((item) => matches(item, needle)) }))
        .filter((group) => group.items.length > 0);
});
const rowGroups = computed(() => shown.value.filter((group) => group.origin !== `base`));
const staples = computed(() => shown.value.find((group) => group.origin === `base`));

/* The strip opens ONE sentence at a time, where the rows open independently. A pill is 100px wide and its
 * sentence is a paragraph — several open at once would push the strip apart and lose the grid that makes it
 * scannable — so the sentence lands under the whole strip and the next pill replaces it. */
const picked = ref<string>();
const pick = (id: string): void => {
    picked.value = picked.value === id ? undefined : id;
};
const pickedItem = computed(() => staples.value?.items.find((item) => item.id === picked.value));

// At most three version chips on a row; a toolchain installs more commands than a row can carry, and the rest
// are in the expansion. Three because it is what fits beside the longest names at the narrowest width.
const CHIP_LIMIT = 3;
const chips = (item: EnvironmentItem): EnvironmentItem[`tools`] => item.tools.slice(0, CHIP_LIMIT);

/* A single-tool row is usually NAMED after its tool ("ffmpeg", "bun"), and printing that name twice on one line
 * — once as the title, once on the chip beside it — reads as a rendering bug. So the chip drops to the bare
 * version there, and keeps its name wherever the row installs more than its own namesake. */
const chipLabel = (item: EnvironmentItem, tool: EnvironmentItem[`tools`][number]): string =>
    item.tools.length === 1 && tool.name.toLowerCase() === item.name.toLowerCase() ? `` : tool.name;

// Where a number came from, on the number itself. This was three lines of preamble above the list, which is a
// lot of permanent space for a claim each reader checks once — and it was nowhere near the thing it vouches for.
const provenance = (tool: EnvironmentItem[`tools`][number]): string => `Read by running ${tool.name} in this sandbox, just now`;

/* WHAT THE ROW SAYS ABOUT ITS OWN STATE, and only when there is something to say. An `active` item gets no
 * badge at all — the whole list is things the sandbox has, so marking the normal case would put a green tick on
 * every line and leave the two that matter no louder than the rest. */
const STATES = {
    active: undefined,
    "after-rebuild": { icon: `clock`, label: `arrives after rebuild`, tone: `text-warning` },
    "awaiting-approval": { icon: `sparkles`, label: `waiting for your approval`, tone: `text-link` },
} as const;
const stateOf = (item: EnvironmentItem) => STATES[item.state];

/* WHO PULLED IT IN, and only when that adds something. The label the daemon sends is "<capability> capability",
 * which beside a row already named `docker`, inside a group already headed "From your capabilities", is the same
 * word three times. What survives the rule is what nobody could have guessed: "workspace extension", "a
 * connected AI account". */
const attribution = (item: EnvironmentItem): string | undefined =>
    item.originLabel?.toLowerCase().startsWith(item.name.toLowerCase()) === false ? item.originLabel : undefined;

/* WHAT AN OPENED ROW SHOWS: the comment the agent wrote, whole, from the top. Not the row's line and then the
 * rest of it — the row's line is a SUMMARY of this paragraph (a trailing parenthetical dropped, an over-long
 * sentence cut back to its claim), so stacking the two printed the opening twice, once cut and once in full,
 * which is what the reader was seeing. */
const explanation = (item: EnvironmentItem): string => item.detail ?? item.purpose ?? ``;

/* AND IT LEADS WITH THE OPENING PARAGRAPH. A toolchain's rationale runs to bullets, CI history and the reason a
 * package list is copied verbatim — all worth keeping, none of it worth landing at once on somebody who clicked
 * a row to find out why Rust is in here. Cut at the paragraph break the agent wrote rather than at a line count,
 * so "there is more" is a fact about the text instead of a guess about the width it renders at. */
const paragraphs = (item: EnvironmentItem): string[] => explanation(item).split(`\n\n`);
const opening = (item: EnvironmentItem): string => paragraphs(item)[0] ?? ``;
const rest = (item: EnvironmentItem): string => paragraphs(item).slice(1).join(`\n\n`);
// Anything the row had to leave out. The plumbing count is in here too, so a block that installs nothing but
// libraries still has somewhere to say so.
const expandable = (item: EnvironmentItem): boolean => item.detail !== undefined || item.commands !== undefined || item.extras !== undefined;

// The count a group's header carries. "3 items" rather than a bare number, because the number sits next to
// version numbers and a lone "3" beside "1.90.0" reads as one more of them.
const countLabel = (group: ContentsGroup): string => `${group.items.length} ${group.items.length === 1 ? `item` : `items`}`;
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- One line, and it earns its place twice: the sentence that makes the versions trustworthy, and the
             one control that answers "is X in here?" without scrolling. -->
        <div v-if="groups.length > 0" class="flex flex-wrap items-center justify-between gap-2">
            <p class="min-w-0 text-2xs text-subtle">
                Read from this sandbox just now, not from the recipe.
                <template v-if="awaiting > 0">
                    {{ awaiting === 1 ? `One entry is` : `${awaiting} entries are` }} waiting for your approval and not installed yet.
                </template>
            </p>
            <SearchBar
                v-model="query"
                variant="field"
                clearable
                placeholder="Find a tool…"
                aria-label="Filter what this sandbox has"
                class="w-44 shrink-0"
            />
        </div>

        <RowGroup v-for="group in rowGroups" :key="group.origin" :label="group.label" :count="countLabel(group)">
            <Row
                v-for="item in group.items"
                :key="item.id"
                density="compact"
                :interactive="expandable(item)"
                :class="item.state === `after-rebuild` ? `opacity-70` : undefined"
                @click="expandable(item) && toggle(item.id)"
            >
                <!-- Not switched off, but not here yet: an entry the recipe has and the container does not gets
                     the drained mark, which says the same thing to someone who cannot see the colour. -->
                <template #lead>
                    <BrandMark
                        :size="22"
                        :name="item.name"
                        :logo="environmentVisual(item).logo"
                        :icon="environmentVisual(item).icon"
                        :idle="item.state !== `active`"
                    />
                </template>
                <!-- NAME, VERSIONS AND SENTENCE ON ONE LINE. The versions ride the name because they are what
                     the name is a version OF, and the sentence takes whatever width is left and truncates —
                     the row had a second line for prose while half its first line sat empty. -->
                <template #title>
                    <!-- CLIPPED, not merely narrow. The chips do not shrink — a version cut in half is worse
                         than a version you scroll to — so on a card sharing its width with the chat column they
                         run past the name and would otherwise paint straight through the trailing facts. -->
                    <span class="flex min-w-0 items-center gap-2 overflow-hidden">
                        <span class="shrink-0">{{ item.name }}</span>
                        <span
                            v-for="tool in chips(item)"
                            :key="tool.name"
                            v-tooltip.bottom="provenance(tool)"
                            class="inline-flex shrink-0 items-baseline gap-1 rounded-full bg-overlay px-1.5 py-0.5 font-mono text-2xs font-normal"
                        >
                            <span v-if="chipLabel(item, tool) !== ``" class="text-content">{{ chipLabel(item, tool) }}</span>
                            <span v-if="tool.version !== undefined" class="text-muted">{{ tool.version }}</span>
                            <span v-else-if="chipLabel(item, tool) === ``" class="text-subtle">installed</span>
                        </span>
                        <span
                            v-if="item.tools.length > CHIP_LIMIT"
                            v-tooltip.bottom="item.tools.map((tool) => tool.name).join(`, `)"
                            class="shrink-0 text-2xs font-normal text-subtle"
                        >
                            +{{ item.tools.length - CHIP_LIMIT }} more
                        </span>
                        <!-- And it steps aside once the row is open: the same sentence is the first line of the
                             disclosure, in full, two lines below. Cut and whole at once reads as a repeat.
                             `.overflow` for the same reason one level down — a tooltip that quotes a line the
                             reader can already see whole is the same repeat in a box. -->
                        <span
                            v-if="item.purpose !== undefined && !open.has(item.id)"
                            v-tooltip.bottom.overflow="item.purpose"
                            class="hidden min-w-0 truncate text-2xs font-normal text-muted sm:block"
                        >
                            {{ item.purpose }}
                        </span>
                    </span>
                </template>
                <!-- Only what the row is worth interrupting for: what pulled the thing in when that is not
                     already obvious, and the two states that are not simply "it is here". -->
                <template #meta>
                    <span v-if="attribution(item) !== undefined" class="hidden shrink-0 sm:inline">{{ attribution(item) }}</span>
                    <span v-if="stateOf(item) !== undefined" :class="stateOf(item)?.tone" class="inline-flex items-center gap-1 font-medium">
                        <Icon :name="stateOf(item)!.icon" />{{ stateOf(item)!.label }}
                    </span>
                    <Icon
                        v-if="expandable(item)"
                        name="chevron-right"
                        class="shrink-0 transition-transform"
                        :class="open.has(item.id) ? `rotate-90` : ``"
                    />
                </template>
                <!-- The slot itself is conditional, not its contents: a row that declares one always gets the
                     gap above it, and twelve pixels of nothing per closed row is what this view is fixing. -->
                <template v-if="open.has(item.id)" #below>
                    <!-- The disclosure keeps its own clicks: the row header is what closes the row, so "Show
                         more" and the code block's copy button must not travel up to it and collapse the thing
                         the reader just asked to see. -->
                    <div class="flex flex-col gap-3" @click.stop>
                        <!-- What the agent wrote, as prose. Its own paragraphs, its own bullet lists — it was
                             written to be read, and rendering it as code would undo that. -->
                        <p class="whitespace-pre-line text-xs leading-relaxed text-muted">
                            {{ full.has(item.id) ? explanation(item) : opening(item) }}
                        </p>
                        <button
                            v-if="rest(item) !== ``"
                            type="button"
                            :class="cmp.linkButton(`gap-1 text-2xs text-muted hover:text-content`)"
                            @click="toggleFull(item.id)"
                        >
                            {{ full.has(item.id) ? `Show less` : `Show more` }}
                            <Icon :name="full.has(item.id) ? `chevron-up` : `chevron-down`" />
                        </button>
                        <!-- The plumbing count belongs here rather than on the row. It is the least useful fact
                             on a line that has to fit a name, its versions and a sentence — nobody runs these —
                             and it was the fact pushing the sentence off a card that shares its width. -->
                        <p v-if="item.extras !== undefined" class="text-2xs text-subtle">
                            Plus {{ item.extras }} libraries and headers these commands need, which nobody runs directly.
                        </p>
                        <!-- Clamped, with the block's own "Show all" underneath: a toolchain's install step is
                             forty lines of apt packages and rustup flags, and unrolling all of it pushes the
                             next row off the screen for a reader who wanted the gist. -->
                        <Code v-if="item.commands !== undefined" :code="item.commands" lang="docker" label="What this installs" :clamp-lines="10" />
                    </div>
                </template>
            </Row>
        </RowGroup>

        <!-- THE STAPLES, AS A STRIP. Thirteen names and thirteen versions, which is the entire question anybody
             brings to this group, in three lines instead of thirteen rows. -->
        <RowGroup v-if="staples !== undefined" :label="staples.label" :count="countLabel(staples)">
            <div class="flex flex-wrap gap-1.5 p-3">
                <button
                    v-for="item in staples.items"
                    :key="item.id"
                    type="button"
                    :disabled="item.purpose === undefined"
                    class="inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-2xs transition-colors enabled:cursor-pointer"
                    :class="
                        picked === item.id
                            ? `border-line-strong bg-overlay text-content`
                            : `border-line bg-canvas text-muted enabled:hover:border-line-strong enabled:hover:text-content`
                    "
                    @click="pick(item.id)"
                >
                    <BrandMark :size="18" :name="item.name" :logo="environmentVisual(item).logo" :icon="environmentVisual(item).icon" />
                    <span class="font-medium">{{ item.name }}</span>
                    <span v-if="item.tools[0]?.version !== undefined" v-tooltip.bottom="provenance(item.tools[0])" class="font-mono text-subtle">
                        {{ item.tools[0].version }}
                    </span>
                </button>
            </div>
            <!-- Under the strip rather than beside the pill, so opening one never reflows the grid above it. -->
            <p v-if="pickedItem !== undefined" class="px-3 py-2 text-2xs text-muted">
                <span class="font-medium text-content">{{ pickedItem.name }}</span> — {{ pickedItem.purpose }}
            </p>
        </RowGroup>

        <!-- Four different sentences, and telling them apart matters: still asking, could not ask, asked and
             there is genuinely nothing, and a filter that matched nothing. -->
        <div v-if="loading" :class="cmp.emptyState(`py-8`)"><Icon name="spinner" class="mr-1.5 animate-spin" />Checking installed versions…</div>
        <Notice v-else-if="error !== undefined" :of="{ tone: `warning`, title: `Could not read what the sandbox has installed.`, detail: error }" />
        <div v-else-if="groups.length === 0" :class="cmp.emptyState(`py-8`)">
            Nothing added on top of the stock image yet — and nothing in it answered, which usually means the sandbox is still starting.
        </div>
        <div v-else-if="shown.length === 0" :class="cmp.emptyState(`py-8`)">Nothing here matches “{{ query.trim() }}”.</div>
    </div>
</template>
