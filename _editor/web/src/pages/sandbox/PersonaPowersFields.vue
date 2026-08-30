<script setup lang="ts">
import { ui, Notice, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import type { PersonaGrantable, PersonaPowersDraft } from "../../composables/sandbox/personaCard";

/* WHAT A PERSONA MAY DO: the shelves, and the per-id grants under them. Its own component because two surfaces
 * ask this exact question and neither is allowed to answer it differently: the full editor on the Personas page,
 * and the Advanced section of the quick panel behind a directory row's persona icon in the Workspace tree.
 *
 * These switches are the one part of a card where a copy that drifts is a SECURITY surprise rather than a cosmetic
 * one: a surface missing a shelf silently grants it, and the reader has no way to see the difference. So the list
 * of shelves, the wording of each consequence, and the caveat about the shell all live here once.
 *
 * SPLIT BY BLAST RADIUS, which is the one grouping that answers the question a reader actually arrives with.
 * These were nine controls in a flat column of equal weight, and nine equal things is a list nobody reads: the
 * file dropdown that decides whether a session can rewrite the repo sat in the same visual rank as which MCP
 * connections it may call. So: what this persona can do TO YOUR WORKSPACE, then what it can REACH beyond it.
 * Everything is still visible and nothing is behind a disclosure, because a permission you cannot see is one you
 * cannot audit, and halving the scan was never worth hiding the switch that matters most.
 *
 * THOSE TWO GROUPS SIT SIDE BY SIDE, and the split is at the GROUP and never at the row. A reader arrives asking
 * "which of these did I turn off?", and that scan works only because every switch in a group shares one gutter:
 * reflowing the rows themselves into two columns would put two gutters on screen and turn the one audit this
 * surface exists for into a zigzag. So each column keeps its single edge of switches, and the second column buys
 * back the half of the card that used to be empty.
 *
 * A @CONTAINER, not a breakpoint, because this component's width is not the window's: the editor gives it most of
 * a card and the tree's quick panel gives it a popover. It answers to whichever it got and folds back to one
 * column on its own.
 *
 * THE SWITCH SITS AT THE ROW'S TRAILING EDGE with the consequence beneath the label, rather than in a third
 * column after a fixed-width label. At half the width that ran out of room: every hint wrapped, so rows went
 * ragged and the gutter they are scanned by stopped being straight. Trailing switches are one hard right edge per
 * column at any width, which is the property worth protecting.
 *
 * EACH ROW WEARS A GLYPH, dim and all one size in a fixed-width rail. It is for re-finding rather than for
 * explaining: on a card you come back to, "look for the globe" beats reading seven labels, and a mark at each
 * left edge chunks a seven-row group that otherwise reads as one block. Deliberately quiet: on a permissions card
 * the loudest pixel has to be the switch state, and a bright icon column would compete with it for the eye. The
 * rows that actually earn one are the jargon ones: Delegate, Connectors, MCP connections, but a list that icons
 * half its rows reads as a bug, so every row gets one.
 *
 * The draft is the parent's, mutated in place, same contract as <PersonaForm>, for the same reason: the parent
 * owns the whole card and has to read these fields back to decide whether anything was bounded at all. */

const {
    draft,
    grantables,
    folderBound = false,
} = defineProps<{
    draft: PersonaPowersDraft;
    /** The connectors, computers and MCP connections this sandbox has, for the per-id grants. */
    grantables: readonly PersonaGrantable[];
    /** Whether the parent's form has ALSO fenced this card to a set of folders: the shell caveat's third case. */
    folderBound?: boolean;
}>();

const FILE_ACCESS = [
    { label: `None`, value: `none` as const },
    { label: `Read`, value: `read` as const },
    { label: `Read & change`, value: `write` as const },
];

/* The rail, and the indent that keeps a hint under its own label rather than under the glyph. One place, because
 * the moment two rows disagree about either the column stops being a column. */
const RAIL = `w-4 shrink-0 text-center text-xs text-subtle`;
const HINT = `pl-6 text-xs text-subtle`;

/* THE SWITCHES, WITH THE CONSEQUENCE OF TURNING EACH OFF WRITTEN NEXT TO IT. A row that says only "Run
 * commands" makes the reader guess whether tests still run; saying what goes away is the difference between a
 * setting somebody sets and one they leave alone because they cannot predict it. */

// What it can do to the workspace itself. The files dropdown leads because it is the widest of them and the
// one a reader most often came here to change; `sandbox` is beside it because the sandbox's own settings and
// the public outbox ARE workspace files: an ordinary edit reaches both.
const WORKSPACE_SHELVES = [
    {
        key: `sandbox` as const,
        icon: `cog` as const,
        label: `Change the sandbox`,
        hint: `Its own settings and manifests, and the folder that publishes files publicly.`,
    },
];

// What it can reach past the workspace. `shell` heads this group rather than the one above precisely because it
// is not a workspace power: a command can post, fetch, install and read a credential, which is why the caveat
// below is the only sentence on this card printed in a warning tone.
const OUTWARD_SHELVES = [
    { key: `shell` as const, icon: `terminal` as const, label: `Run commands`, hint: `Shell, tests, builds, and every CLI on the image.` },
    /* The second execution backend, directly under the first: the two are one question asked twice ("what may
     * a session RUN"), and a reader deciding one wants the other in view. Its hint says what makes it the
     * smaller grant: the runtime itself fences its reads and writes to the Files answer above, and it cannot
     * start programs unless Run commands is also on, because that difference is the whole reason a card
     * would keep this on while switching the shell off. */
    {
        key: `code` as const,
        icon: `code` as const,
        label: `Run code`,
        hint: `JavaScript runs fenced by the runtime: files follow the Files answer, no programs without Run commands.`,
    },
    /* A globe ALSO stands for a browser account whose site has no logo of its own, a section up in the editor.
     * The collision is real and the globe stays here anyway, because the alternative is worse: that mark comes
     * from useBrowserAccounts, which exists precisely so one account wears one mark everywhere, and moving it
     * would make the same account a globe on /capabilities and something else here. So the two are told apart by
     * treatment instead: an account's mark is coloured and sits on its own plate, this is a dim line glyph in a
     * rail of them, and the globe goes to the row it describes best. */
    { key: `web` as const, icon: `globe` as const, label: `Read the web`, hint: `Fetch a page, run a search.` },
    // Says what it is NOT rather than pointing at the account picker: this component renders in the quick panel
    // too, which has no picker, and "the list above" was then a reference to nothing.
    /* A FRAMED WINDOW, and it is the nearest thing this set has: there is no browser glyph in it and the globe
     * is spoken for. `window-maximize` was the first guess and drew Remix's fullscreen arrows, which say "make
     * this bigger" to a reader deciding whether a session may drive Chrome. */
    {
        key: `browser` as const,
        icon: `picture-in-picture` as const,
        label: `Drive a browser`,
        hint: `The anonymous browser, not the signed-in accounts.`,
    },
    // A hierarchy branching into children, which is what delegating IS. A group of people was the first guess and
    // drew one indistinct blob at this size, and said "several people" where the row means "several agents".
    { key: `delegate` as const, icon: `sitemap` as const, label: `Delegate`, hint: `Spawn sub-agents and run workflows.` },
];

const GRANT_GROUPS = [
    // `link` over a wrench: the reader maps the glyph to the word beside it, and the word is Connectors.
    { key: `connectors` as const, kind: `cli` as const, icon: `link` as const, label: `Connectors`, empty: `No connectors added yet.` },
    {
        key: `computers` as const,
        kind: `host` as const,
        icon: `desktop` as const,
        label: `Your computers`,
        empty: `No computers connected yet.`,
    },
    { key: `mcp` as const, kind: `mcp` as const, icon: `server` as const, label: `MCP connections`, empty: `No MCP connections added yet.` },
];

const groupItems = (kind: PersonaGrantable[`kind`]): PersonaGrantable[] => grantables.filter((entry) => entry.kind === kind);

// `undefined` is "every one of them", so an unset group reads as all-picked: including anything connected
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
 * the whole point: a limit that is weaker than it looks is worse than no limit, and the person setting it is
 * the only one who can decide whether that trade is fine for this persona. Raised by any bound the shell can
 * walk around, which is every per-id grant and the folder fence the parent may have set. */
const shellCaveat = computed(
    () => draft.shell && (draft.connectors !== undefined || draft.computers !== undefined || draft.mcp !== undefined || folderBound),
);
</script>

<template>
    <div class="@container">
        <!-- The fold is at @2xl and not higher: this app's root font is 17.6px, so a rem threshold lands ~10%
             wider than it reads, and @3xl kept an opened card in one column on any window narrower than about
             1100px, which is most of them once a chat panel is docked beside it. -->
        <div class="grid items-start gap-x-10 gap-y-6 @2xl:grid-cols-2">
            <!-- IN YOUR WORKSPACE: what changes what this box holds, and then where in it this card may stand.
                 The location fields belong to whichever parent HAS them (the editor does, the quick panel does
                 not), so they arrive through the slot rather than being rendered here. -->
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

                <!-- The rail goes OUT with the slot. Whatever the parent hangs here has to line up with the rows
                     above it or the column stops being one, and a second copy of these classes in the parent is
                     how that alignment quietly drifts apart. -->
                <slot name="where" :rail="RAIL" />
            </div>

            <!-- REACHING OUT: everything whose consequences leave this box. -->
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

                <!-- The one caveat this form owes the reader, and only when it is actually load-bearing: a card
                     that has bounded something WHILE leaving the shell on. Silent otherwise, because a full-powers
                     card has nothing to be misled about. -->
                <Notice v-if="shellCaveat" tone="warning">
                    With <strong>Run commands</strong> on, every other limit on this card is a strong default rather than a wall: a session with a
                    shell can reach a credential it wasn't granted. Turn it off for a persona that has to be fenced in.
                </Notice>

                <!-- The per-id grants. Collapsed to one line while a group is set to everything, which is the
                     default and the answer most cards keep: a wall of checkboxes for a question nobody asked would
                     bury the switches above that people do come here to set. -->
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
                    <!-- Indented to the label rather than to a vanished label column: the chips are what that
                         row's switch just handed over, and they read as its answer only while they line up
                         under it. Outside the <label>, because a chip inside it would toggle the group off. -->
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
