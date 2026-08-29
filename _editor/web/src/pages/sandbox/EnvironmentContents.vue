<script setup lang="ts">
import type { EnvironmentItem } from "@intentic-app/api-contract";
import { BrandMark, Code, DisclosureRow, Notice, RowGroup, RowNote, SearchBar, SkeletonRows, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import type { ContentsGroup } from "../../composables/sandbox/useEnvironmentContents";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import { environmentVisual } from "./environmentVisual";

/* THE SANDBOX AS CONTENTS rather than as a build recipe: the answer to "what can this thing do?", which is what
 * people actually open the Environment tab for. The recipe stays one pill away for whoever wants to see exactly
 * what runs.
 *
 * TWO PRESENTATIONS, BECAUSE THE GROUPS ARE ASKED DIFFERENT QUESTIONS. What an agent added and what a capability
 * costs are DECISIONS: few, rationale attached, worth reading, and the reason someone opened this tab. What
 * ships with every sandbox is a LOOKUP: nobody reads "Git, every repo in the workspace is a real git repo",
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
 * ONE FILLED SHAPE IN THE WHOLE VIEW, AND IT MEANS "CLICK ME". This tab drew a version two ways: a filled
 * capsule on the rows, and a bordered capsule in the staples strip painted in the PAGE's background: one
 * stepping up off the card, one punching a hole in it, for the same fact. So a version is now plain tabular
 * text wherever it merely annotates a name (a version is a footnote to the thing it versions; a filled badge
 * made it louder than the name itself), and the capsule survives only in the strip, where the capsule IS the
 * button. Fill therefore says "this is a target" everywhere on the tab instead of saying nothing twice.
 *
 * THE EXPLANATION IS STILL NOT HOVER-ONLY. Hover was the obvious way to hang these rationales off a compact view
 * and it is the wrong one: it does not exist on a touch screen, it is awkward from the keyboard, and a
 * twenty-line box that vanishes when the pointer crosses a gap is not a place anybody reads. A click opens the
 * paragraph in place. Hover stays what it is good for: text that had to be cut, and the provenance of a version
 * number: a footnote read once, which used to cost three lines at the top of the tab.
 *
 * AND NOTHING IS SHOWN TWICE, WHICH TOOK BOTH SIDES. Every long entry here used to open on its own opening
 * sentence twice: once as the row's trimmed line, once as the head of the paragraph below it, because the
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

// Whether the wait has lasted long enough to be worth drawing. Wrapped in a computed because the gate watches a
// source that can change, and a destructured prop is a reactive REFERENCE rather than a ref it can watch.
const outline = useSandboxOutline(computed(() => loading));

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

/* ONE FILTER FOR THE WHOLE TAB, not one per group. "Is X installed?" does not know which group X is in: ffmpeg
 * is a workspace addition here and a staple on the next sandbox, so a filter attached to the long group would
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
 * sentence is a paragraph: several open at once would push the strip apart and lose the grid that makes it
 * scannable, so the sentence lands under the whole strip and the next pill replaces it. */
const picked = ref<string>();
const pick = (id: string): void => {
    picked.value = picked.value === id ? undefined : id;
};
const pickedItem = computed(() => staples.value?.items.find((item) => item.id === picked.value));

// At most three versions on a row; a toolchain installs more commands than a row can carry, and the rest are in
// the expansion. Three because it is what fits beside the longest names at the narrowest width.
const SHOWN_TOOLS = 3;
const shownTools = (item: EnvironmentItem): EnvironmentItem[`tools`] => item.tools.slice(0, SHOWN_TOOLS);

/* A single-tool row is usually NAMED after its tool ("ffmpeg", "bun"), and printing that name twice on one line
 * (once as the title, once beside the version) reads as a rendering bug. So the version stands alone there,
 * and keeps its command's name wherever the row installs more than its own namesake. */
const toolLabel = (item: EnvironmentItem, tool: EnvironmentItem[`tools`][number]): string =>
    item.tools.length === 1 && tool.name.toLowerCase() === item.name.toLowerCase() ? `` : tool.name;

// Where a number came from, on the number itself. This was three lines of preamble above the list, which is a
// lot of permanent space for a claim each reader checks once, and it was nowhere near the thing it vouches for.
const provenance = (tool: EnvironmentItem[`tools`][number]): string => `Read by running ${tool.name} in this sandbox, just now`;

/* WHAT THE ROW SAYS ABOUT ITS OWN STATE, and only when there is something to say. An `active` item gets no
 * badge at all: the whole list is things the sandbox has, so marking the normal case would put a green tick on
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
 * rest of it: the row's line is a SUMMARY of this paragraph (a trailing parenthetical dropped, an over-long
 * sentence cut back to its claim), so stacking the two printed the opening twice, once cut and once in full,
 * which is what the reader was seeing. */
const explanation = (item: EnvironmentItem): string => item.detail ?? item.purpose ?? ``;

/* AND IT LEADS WITH THE OPENING PARAGRAPH. A toolchain's rationale runs to bullets, CI history and the reason a
 * package list is copied verbatim: all worth keeping, none of it worth landing at once on somebody who clicked
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
    <!-- `gap-5`, which is what separates the sections now that none of them is boxed: a group's own rows sit flush
         against each other, so the space between one group's last row and the next group's label has to be the
         biggest gap in the list, or the labels stop reading as breaks. -->
    <div class="flex flex-col gap-5">
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

        <!-- `flat`, because this list is already inside the Environment card: a bordered group per section drew a
             frame around a surface painted in the card's own colour, so the section labels and the gap between
             them do the grouping and the card stays the only frame. -->
        <RowGroup v-for="group in rowGroups" :key="group.origin" flat undivided :label="group.label" :count="countLabel(group)">
            <!-- The row's chevron used to ride in `#meta`, at the TRAILING edge among the facts, which is where
                 the verbs live and not where a reader looks for a disclosure. <DisclosureRow> puts it in the
                 lead column with the rest of the app's expandable rows, and `disabled` is how a row with
                 nothing behind it says so: no arrow, no hover, no tab stop.
                 The "Show more" inside the opened block keeps its own `chevron-up`/`chevron-down` swap, and
                 should: that is a text clamp, not a row disclosure, and its arrow points at what the press
                 will do rather than at where the content is. -->

            <DisclosureRow
                v-for="item in group.items"
                :key="item.id"
                :disabled="!expandable(item)"
                :class="item.state === `after-rebuild` ? `opacity-70` : undefined"
                :open="open.has(item.id)"
                @update:open="toggle(item.id)"
            >
                <!-- Not switched off, but not here yet: an entry the recipe has and the container does not gets
                     the drained mark, which says the same thing to someone who cannot see the colour. -->
                <template #lead="{ mark }">
                    <BrandMark
                        :size="mark"
                        :name="item.name"
                        :logo="environmentVisual(item).logo"
                        :icon="environmentVisual(item).icon"
                        :idle="item.state !== `active`"
                    />
                </template>
                <!-- NAME, VERSIONS AND SENTENCE ON ONE LINE. The versions ride the name because they are what
                     the name is a version OF, and the sentence takes whatever width is left and truncates:
                     the row had a second line for prose while half its first line sat empty. -->
                <template #title>
                    <!-- The line's own clip, so nothing runs through the trailing facts on a card sharing its
                         width with the chat column. What each part does when the width runs out is stated where
                         that part is: the name never yields, the versions truncate past half the line, the
                         sentence yields first and to nothing. -->
                    <span class="flex min-w-0 items-center gap-3 overflow-hidden">
                        <span class="shrink-0">{{ item.name }}</span>
                        <!-- The version cluster: mono against the name's sans, which is what separates the two
                             without a shape around either, and a wider gap between pairs than inside one, which
                             is what keeps "chromium 140.0.7339" from reading as "140.0.7339 node". Each pair
                             keeps its own tooltip, so provenance still belongs to the number it vouches for.

                             AND IT ELLIPSES RATHER THAN CLIPPING, BUT ONLY PAST ITS SHARE OF THE ROW. A number
                             sliced at the row's edge is not a truncated number: it is a DIFFERENT one, read as
                             complete ("node 24.18" for 24.18.0), which is what a card sharing its width with
                             the chat column did to a toolchain's third version. So the cluster keeps its full
                             width up to half the line and truncates visibly past that: a lone `psql 16.4` is
                             never cut, three versions give the sentence half the row rather than all of it, and
                             what a row cannot fit is on the tooltip and in the expansion either way. -->
                        <span v-if="item.tools.length > 0" class="min-w-0 max-w-[50%] shrink-0 truncate font-mono text-2xs font-normal tabular-nums">
                            <span v-for="tool in shownTools(item)" :key="tool.name" v-tooltip.bottom="provenance(tool)" class="mr-3 last:mr-0">
                                <span v-if="toolLabel(item, tool) !== ``" class="text-muted">{{ toolLabel(item, tool) }}&nbsp;</span>
                                <span v-if="tool.version !== undefined" class="text-subtle">{{ tool.version }}</span>
                                <span v-else-if="toolLabel(item, tool) === ``" class="text-subtle">installed</span>
                            </span>
                            <span
                                v-if="item.tools.length > SHOWN_TOOLS"
                                v-tooltip.bottom="item.tools.map((tool) => tool.name).join(`, `)"
                                class="text-subtle"
                            >
                                +{{ item.tools.length - SHOWN_TOOLS }} more
                            </span>
                        </span>
                        <!-- And it steps aside once the row is open: the same sentence is the first line of the
                             disclosure, in full, two lines below. Cut and whole at once reads as a repeat.
                             `.overflow` for the same reason one level down: a tooltip that quotes a line the
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
                </template>
                <!-- The slot itself is conditional, not its contents: a row that declares one always gets the
                     gap above it, and twelve pixels of nothing per closed row is what this view is fixing. -->
                <template #below>
                    <!-- No `@click.stop` any more: the disclosure's hit area is the row's HEADER, and this block
                         is that button's sibling, so "Show more" and the code block's copy button cannot travel
                         up to it and collapse the thing the reader just asked to see. -->
                    <div class="flex flex-col gap-3">
                        <!-- What the agent wrote, as prose. Its own paragraphs, its own bullet lists: it was
                             written to be read, and rendering it as code would undo that. -->
                        <p class="whitespace-pre-line text-xs leading-relaxed text-muted">
                            {{ full.has(item.id) ? explanation(item) : opening(item) }}
                        </p>
                        <button
                            v-if="rest(item) !== ``"
                            type="button"
                            :class="ui.linkButton(`gap-1 text-2xs text-muted hover:text-content`)"
                            @click="toggleFull(item.id)"
                        >
                            {{ full.has(item.id) ? `Show less` : `Show more` }}
                            <Icon :name="full.has(item.id) ? `chevron-up` : `chevron-down`" />
                        </button>
                        <!-- The plumbing count belongs here rather than on the row. It is the least useful fact
                             on a line that has to fit a name, its versions and a sentence: nobody runs these:
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
            </DisclosureRow>
        </RowGroup>

        <!-- THE STAPLES, AS A STRIP. Thirteen names and thirteen versions, which is the entire question anybody
             brings to this group, in three lines instead of thirteen rows. -->
        <RowGroup v-if="staples !== undefined" flat :label="staples.label" :count="countLabel(staples)">
            <!-- Strip AND sentence in one child of the group, so the group's row divider does not draw a line
                 between a pill and the sentence that pill just opened. Aligned with the rows above by taking
                 the group's own tier (<RowNote variant="block">) rather than by restating their `px-4`, so all
                 three sections start at one left edge and go on doing so if the tier moves. -->
            <RowNote variant="block">
                <div class="flex flex-col gap-2">
                    <div class="flex flex-wrap gap-1.5">
                        <!-- THE ONE CAPSULE ON THE TAB. Tinted rather than outlined: an outline inside a card is a
                         fourth stroke, where a tint of the text colour steps off the surface in both schemes (the
                         old `bg-canvas` fill was the PAGE behind the card, so a pill read as a hole in it). It
                         carries the app's own selected tint when open, the same one every picked row uses. -->
                        <button
                            v-for="item in staples.items"
                            :key="item.id"
                            type="button"
                            :disabled="item.purpose === undefined"
                            class="inline-flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-2xs transition-colors enabled:cursor-pointer"
                            :class="
                                picked === item.id
                                    ? `ui-row-select-on text-content`
                                    : `bg-content/5 text-muted enabled:hover:bg-content/10 enabled:hover:text-content`
                            "
                            @click="pick(item.id)"
                        >
                            <BrandMark :size="18" :name="item.name" :logo="environmentVisual(item).logo" :icon="environmentVisual(item).icon" />
                            <span class="font-medium">{{ item.name }}</span>
                            <span
                                v-if="item.tools[0]?.version !== undefined"
                                v-tooltip.bottom="provenance(item.tools[0])"
                                class="font-mono tabular-nums text-subtle"
                            >
                                {{ item.tools[0].version }}
                            </span>
                        </button>
                    </div>
                    <!-- Under the strip rather than beside the pill, so opening one never reflows the grid above it. -->
                    <p v-if="pickedItem !== undefined" class="text-2xs text-muted">
                        <span class="font-medium text-content">{{ pickedItem.name }}</span
                        >: {{ pickedItem.purpose }}
                    </p>
                </div>
            </RowNote>
        </RowGroup>

        <!-- Four different sentences, and telling them apart matters: still asking, could not ask, asked and
             there is genuinely nothing, and a filter that matched nothing.

             THE FIRST OF THE FOUR IS DRAWN, NOT SAID, and this is the longest wait in the hub to draw: the read
             behind it asks every tool on the overlay for its version, one process spawn each, so it is measured
             in seconds rather than in the round-trip the other tabs pay. A spinner over an empty card for that
             long is the view at its least informative exactly when it is on screen the longest, and what is
             coming is highly regular (labelled sections of name-and-version rows, then the staples strip), so
             the shape is worth far more here than the sentence was. -->
        <div v-if="loading && outline" class="flex flex-col gap-5" role="status" aria-busy="true">
            <span class="sr-only">Checking installed versions…</span>
            <!-- Two sections rather than the three that can appear: the outline promises the shape, and a
                 sandbox with nothing added on top has only the base group: over-promising sections is how a
                 placeholder ends up taller than the answer. -->
            <RowGroup v-for="(section, index) in [4, 3]" :key="index" flat undivided>
                <template #label><span class="skeleton block h-2.5" :class="index === 0 ? `w-44` : `w-36`" aria-hidden="true" /></template>
                <SkeletonRows :rows="section" />
            </RowGroup>
            <!-- The staples strip: thirteen pills of a name and a version, which is a different shape from a
                 row and reads as one at a glance. -->
            <RowGroup flat>
                <template #label><span class="skeleton block h-2.5 w-28" aria-hidden="true" /></template>
                <RowNote variant="block">
                    <div class="flex flex-wrap gap-1.5" aria-hidden="true">
                        <span
                            v-for="(width, index) in [`w-24`, `w-20`, `w-28`, `w-16`, `w-24`, `w-20`, `w-32`, `w-20`]"
                            :key="index"
                            class="skeleton block h-6 rounded-full"
                            :class="width"
                        />
                    </div>
                </RowNote>
            </RowGroup>
        </div>
        <!-- The sentence survives for the beat before the outline is allowed to appear: nothing at all is drawn
             then, and `loading` still owns which of the four states this is. -->
        <template v-else-if="loading" />
        <Notice v-else-if="error !== undefined" :of="{ tone: `warning`, title: `Could not read what the sandbox has installed.`, detail: error }" />
        <div v-else-if="groups.length === 0" :class="ui.emptyState(`py-8`)">
            Nothing added on top of the stock image yet, and nothing in it answered, which usually means the sandbox is still starting.
        </div>
        <div v-else-if="shown.length === 0" :class="ui.emptyState(`py-8`)">Nothing here matches "{{ query.trim() }}".</div>
    </div>
</template>
