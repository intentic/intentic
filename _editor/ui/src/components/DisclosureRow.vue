<!-- A RECORD ROW THAT OPENS INTO ITS OWN EVIDENCE. The app's one answer to "collapsed is the claim, expanded is
     the working", and it exists because there were fourteen answers: the ports list, the activity feed, the
     chores board, the acceptance stories and their report, the automations list, the deployments and pipelines
     boards, the extensions list, the skills list, the secrets list, the machine report, the personas list and
     the environment contents. Between them they spelled the SAME control five ways, indented the opened block
     to four different columns, painted the open row in four different tints, and got `aria-controls` onto two
     rows out of fourteen.

     THE GLYPH IS A CHEVRON, ON THE LEFT, AND THAT IS NOT A STYLE PREFERENCE.

       · `(i)` is taken. In this app it means <InfoHint>: hover, read a definition, nothing moves. The ports
         row used it as a TOGGLE, thirty pixels under a real <InfoHint> in its own group header — one glyph,
         two behaviours, one viewport, and the only way to learn which was which was to click and find out.
       · A rotation IS the state; a morph is not. `(i) → chevron-up` share no visual family, so a list of
         twelve rows gives a reader nothing to scan for "which of these did I open". The arrow's angle does.
       · The left edge is where structure lives and the right edge is where verbs live. A leading chevron puts
         every row's toggle in ONE vertical column. In the trailing cluster it moves row to row as the verbs
         come and go, and on the ports list it sat one mis-click from the button that publishes a port to the
         public internet.
       · The chevron and the row's own mark are ONE hit area. A disclosure whose only target is a 12px arrow
         is a disclosure nobody finds — the argument <MachineDetail> and the activity feed had both already
         written down, and the one thing every hand-rolled version got right.

     THE OPENED BLOCK IS INDENTED AND RAILED, and the indent is DERIVED. `#below` is full-width by <Row>'s
     contract, so evidence drawn at the row's own left edge starts to the LEFT of the title it belongs to and
     reads as the list's rather than the row's. Every call site knew this and fixed it with a number: `pl-5`,
     `pl-8`, `pl-9`, `pl-10` — four guesses at one distance, each stale the moment an icon changes size. Here
     the spacer is the toggle cluster itself, drawn a second time and hidden, so it cannot be wrong and cannot
     go stale. The rail is the other half: it says where one open row's content ENDS, which is the question you
     have the moment two of them are open at once.

     BECAUSE THE LEAD IS DRAWN TWICE, `#lead` MUST BE PRESENTATIONAL — a glyph, a status dot, a brand mark.
     Nothing stateful, nothing focusable, nothing that fires on mount. The mirror is `invisible` and
     `aria-hidden`, so a control in there would be a second, unreachable copy of itself.

     TWO BODY SHAPES, AND THE TEST BETWEEN THEM IS NOT LENGTH:
       · `rail` (default) — the block is EVIDENCE ABOUT THIS ROW. The command line behind a port, the events
         behind a turn, the packages behind a chore's count. It belongs to the row's title, so it hangs off it.
       · `drawer` — the block is A PLACE OF ITS OWN: an editor, a form, a report with its own headings. It gets
         the full width, parted from the header by a hairline, because railing a form to a row's title makes the
         form look like a footnote. If you cannot say which one you have, you have `rail`.

     A DRAWER TAKES NO SURFACE OF ITS OWN. It sits in the open row's wash like the header does, so an expanded
     row is ONE block. Three of the four hand-rolled drawers painted themselves `bg-canvas` under a header
     tinted `bg-content/6` or `bg-overlay`, which splits a row in half down a colour change and makes the lower
     half read as belonging to the page rather than to the name above it.

     STATE IS THE CALLER'S OR OURS, either way. `v-model:open` for a row that minds its own business; pass
     `open` and handle `update:open` for the accordion lists whose parent already tracks which one is up. -->
<script setup lang="ts">
import { computed, useId } from "vue";
import Icon from "./Icon.vue";
import Row from "./Row.vue";
import type { IconName } from "../icons/iconSets.js";
import { ROW_TIERS, ROW_TOGGLE_GAPS, ROW_TOGGLE_SIZES, type RowDensity, type RowTone } from "./row.js";

const {
    open = false,
    density = `comfortable`,
    hit = `header`,
    body = `rail`,
    tone = `default`,
    disabled = false,
    wideControl = false,
} = defineProps<{
    /** Open state. `v-model:open` to let the row keep it; bind + listen to let an accordion parent own it. */
    open?: boolean;
    /** comfortable: settings rows · compact: record lists · dense: navigator rails. Forwarded to <Row>. */
    density?: RowDensity;
    /* WHAT THE PRESS TARGET IS.
     *
     * IT SETS THE ACCESSIBLE BUTTON, NOT THE PRESS TARGET. Pressing the row opens it in every mode (see
     * `onRowClick` for the arithmetic that makes that necessary); what this decides is how much of the row is
     * inside the real <button> a keyboard tabs to, and that turns on one question: does the headline carry a
     * control of its own?
     *
     * `header` — no. The chevron, the `#lead` mark, the title and the description are one button. The default.
     * `pair` — yes. The button is the chevron and the `#lead` mark, because a button inside a button is invalid
     *   markup and a press that both opened the row and left for the vendor would be neither. The headline's
     *   own CONTROLS keep their presses (<Row>'s `headlineGuard`); every other pixel of the headline — a title
     *   that is plain text on this row, the facts line, the preview, the space after a short name — opens the
     *   row like the rest of it. For a turn whose label opens its transcript, a port whose sentence links to
     *   its terminal, a run whose title goes to the CI provider.
     * `row` — yes, but the product answer is "people click the row and there is no second way in" (the personas
     *   list, whose name is click-to-rename). Same button as `pair`, no headline guard, so the name is the
     *   caller's to protect with `@click.stop`. `#control` and the `rail` body are guarded here for everyone. */
    hit?: `header` | `pair` | `row`;
    /** `rail`: evidence about this row · `drawer`: a place of its own. See the note above. */
    body?: `rail` | `drawer`;
    /* Forwarded to <Row> verbatim. Only the four a disclosure row actually reaches for: the rest of <Row>'s
     * surface is slots, which pass through on their own. `class` lands on the WRAPPER (see `tint`), which is
     * what a caller adding an accent stripe or a container query to the whole open row wants. */
    icon?: IconName;
    title?: string;
    description?: string;
    wideControl?: boolean;
    /** Tints <Row>'s `icon`. */
    tone?: RowTone;
    /** A row with nothing behind it: the chevron goes, the row stays. */
    disabled?: boolean;
}>();

const emit = defineEmits<{ "update:open": [open: boolean] }>();

const bodyId = useId();

const toggle = (): void => {
    if (!disabled) {
        emit(`update:open`, !open);
    }
};

/* A DRAG IS NOT A PRESS, and this row has to know the difference because so much of it is now pressable.
 *
 * A record row's evidence is there to be READ and copied out of — an error string, a command line, a session
 * id — and the moment the headline and the row's whitespace became targets, sweeping a selection across them
 * ended in a `click` on the row and closed the thing being copied from. Selecting text to lose it is a worse
 * failure than a dead target, because you cannot even see what you did wrong.
 *
 * MEASURED AGAINST WHERE THE POINTER WENT DOWN rather than asked of `getSelection()`: a selection made
 * somewhere else on the page is still live when you come back and press a row, and that row must still open.
 * `event.detail > 0` keeps the keyboard out of it — Enter and Space on the toggle synthesise a click at (0, 0)
 * with `detail === 0`, which against a real pointer's last position is a "drag" the length of the viewport. */
const PRESS_SLOP_PX = 6;
let pressedAt: { x: number; y: number } | undefined;

const onPointerDown = (event: PointerEvent): void => {
    pressedAt = { x: event.clientX, y: event.clientY };
};

const dragged = (event: MouseEvent): boolean =>
    event.detail > 0 && pressedAt !== undefined && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > PRESS_SLOP_PX;

/* THE WHOLE ROW IS THE TARGET, except where it is a control.
 *
 * The button alone is not enough, and the reason is arithmetic: <Row>'s tier padding is `py-3.5` at
 * `comfortable`, so a press target that stops at the text leaves ~28px of a ~68px row dead, top and bottom,
 * plus the left padding and the gap before the trailing verbs. A row that ignores two presses in five reads as
 * broken, and it read exactly that way on the deployments board, which had also just given up the duplicate
 * chevron that used to catch them.
 *
 * `pair` gets it too, minus the one part it exists to protect: the CONTROLS its headline carries (a link to a
 * run, a terminal, a transcript) keep their own presses via <Row>'s `headlineGuard`. Everything around them —
 * the padding, the lead cluster, the facts, the empty middle, and the headline's own text where that text is
 * not itself a link — still opens the row, which is the difference between a 90px target and the whole line. */
const onRowClick = (event: MouseEvent): void => {
    if (!dragged(event)) {
        toggle();
    }
};

/* THE TOGGLE CLUSTER'S OWN CLICK, with `.stop` written out rather than spelled as a modifier, because it must
 * NOT always apply. In `header` the cluster is a plain <span> INSIDE <Row>'s header button, and a modifier
 * there stops the press before the button that owns it ever sees it: chevron and mark go dead while the title
 * beside them still works, which is precisely how this shipped broken. */
const onPairClick = (event: MouseEvent): void => {
    if (hit === `header`) {
        return;
    }
    event.stopPropagation();
    if (!dragged(event)) {
        toggle();
    }
};

// The tier's own gap between the toggle cluster and the title, and the tighter one INSIDE the cluster. Read
// from <Row>'s table rather than restated, because the hidden mirror below is only right while they match.
const gap = computed(() => ROW_TIERS[density].gap);
const toggleGap = computed(() => ROW_TOGGLE_GAPS[density]);
const chevronSize = computed(() => ROW_TOGGLE_SIZES[density]);

/* THE ONE TINT PAIR, so an open row is the same colour on every list in the app. It was `bg-content/6`,
 * `bg-content/2`, `bg-overlay`, `bg-canvas` and nothing, chosen by which file you were in.
 *
 * It rides on a wrapper rather than on <Row>'s `interactive`, which would also put a pointer cursor over the
 * trailing verbs — a row where only the left region opens should not claim the whole width is pressable. The
 * exception is `hit="row"`, where it IS pressable: there <Row> takes `interactive` and with it the app's own
 * `ui-row-select` (cursor, hover wash, focus ring), so the hover half of this pair would be a second wash
 * stacked on the first. The OPEN half still belongs here, because it has to cover the drawer as well. */
const tint = computed(() => {
    if (disabled) {
        return ``;
    }
    if (open) {
        return `bg-content/6`;
    }
    return ``;
});

// Padding for a drawer, matched to the row's own so the two read as one block rather than as a panel that
// missed its edges by two pixels. Deliberately a shade roomier vertically: a drawer holds a form, not a line.
const DRAWER_PAD = {
    comfortable: `px-4.5 py-4`,
    compact: `px-4 py-3.5`,
    dense: `px-2.5 py-3`,
} as const satisfies Record<RowDensity, string>;
</script>

<template>
    <div class="group" :class="[tint, $slots[`before`] ? `flex flex-col` : ``]" @pointerdown="onPointerDown">
        <!-- `#before` IS THE SELECTION COLUMN, and it is outside the toggle rather than in `#lead` because a
             checkbox nested in a <button> is invalid and unusable: every attempt to tick it would open the row
             instead. It rides inside the tint so the whole line still lights up as one row, which is the part a
             caller putting the checkbox beside the component would lose. Its own padding is the caller's: this
             column's width is a fact about the LIST, not about any row in it. -->
        <div :class="$slots[`before`] ? `flex w-full items-center` : `contents`">
            <div v-if="$slots[`before`]" class="flex shrink-0 items-center"><slot name="before" /></div>
            <Row
                :class="$slots[`before`] ? `min-w-0 flex-1` : ``"
                :density="density"
                :tone="tone"
                :icon="icon"
                :title="title"
                :description="description"
                :wide-control="wideControl"
                :header-button="hit === `header` && !disabled"
                :header-expanded="disabled ? undefined : open"
                :header-controls="disabled ? undefined : bodyId"
                :interactive="!disabled"
                :headline-guard="hit === `pair`"
                @header-click="onRowClick"
                @click="onRowClick"
            >
                <template #lead>
                    <!-- `pair` and `row`: the cluster IS the button, and in `row` it is the KEYBOARD's way in,
                         since the press target over the whole row is a click handler on a div and reaches no
                         one who is tabbing. `header`: <Row>'s left region is the button, so this is inert.
                         `.stop` because in `row` the handler above would otherwise fire on the same click and
                         toggle straight back. -->
                    <component
                        :is="hit !== `header` && !disabled ? `button` : `span`"
                        :type="hit !== `header` && !disabled ? `button` : undefined"
                        :aria-expanded="hit !== `header` && !disabled ? open : undefined"
                        :aria-controls="hit !== `header` && !disabled ? bodyId : undefined"
                        class="flex shrink-0 items-center"
                        :class="[
                            toggleGap,
                            hit !== `header` && !disabled
                                ? `cursor-pointer rounded-sm text-subtle hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500`
                                : ``,
                        ]"
                        @click="onPairClick"
                    >
                        <!-- ROTATION, NOT AN ICON SWAP. It animates, which is the cheapest way to say a press
                         landed, and it is the one spelling that cannot drift: `chevron-up` and `chevron-down`
                         are two names a file can get backwards, and three files had. -->
                        <Icon
                            v-if="!disabled"
                            name="chevron-right"
                            class="shrink-0 text-subtle transition-transform group-hover:text-muted"
                            :class="[chevronSize, open ? `rotate-90` : ``]"
                            aria-hidden="true"
                        />
                        <slot name="lead" />
                    </component>
                </template>

                <template v-if="$slots[`title`]" #title><slot name="title" /></template>
                <template v-if="$slots[`description`]" #description><slot name="description" /></template>
                <template v-if="$slots[`meta`]" #meta><slot name="meta" /></template>
                <template v-if="$slots[`control`]" #control><slot name="control" /></template>

                <!-- THE RAIL. Inside <Row>'s padding, so it aligns with the row above it, and offset by a hidden
                 copy of the toggle cluster, so it starts under the TITLE. -->
                <template v-if="open && body === `rail`" #below>
                    <div class="flex" :class="gap">
                        <!-- THE TOGGLE COLUMN RUNS THE FULL HEIGHT OF AN OPEN ROW. The spacer that aligns the
                             rail was already sitting in the one column a reader has learnt is the toggle's —
                             directly under the chevron — and it was inert, inside a block that stopped every
                             press. So an open row could only be closed from the header line it had just pushed
                             upward, which is the other half of "I can't close this". Left as a press that
                             BUBBLES to the row-wide handler rather than given a handler of its own: this block
                             is inside <Row>, so both would fire and the row would toggle straight back.
                             `cursor-pointer` is stated rather than left to inherit from the row, so this column
                             goes on saying "pressable" beside a body that deliberately says the opposite. -->
                        <span class="flex shrink-0 cursor-pointer items-center" aria-hidden="true">
                            <span class="invisible flex items-center" :class="toggleGap">
                                <Icon v-if="!disabled" name="chevron-right" class="shrink-0" :class="chevronSize" />
                                <slot name="lead" />
                            </span>
                        </span>
                        <!-- `@click.stop` because this block is INSIDE <Row>, and the row-wide handler would
                             read a press on the evidence as "close the thing you just opened". The drawer needs
                             no guard: it is drawn as a sibling of <Row>, outside that handler entirely.
                             `cursor-auto` says the same thing to the pointer, which <Row>'s `ui-row-select`
                             would otherwise have promising a press over an error string nobody can press. -->
                        <div :id="bodyId" class="min-w-0 flex-1 cursor-auto border-l border-line-strong pl-3" @click.stop>
                            <slot name="below" />
                        </div>
                    </div>
                </template>
            </Row>
        </div>

        <!-- THE DRAWER. A sibling of the row rather than <Row>'s `#below`, because it is full-bleed: pulling it
             back out of the row's padding with negative margins would be four numbers to keep in step with the
             tier table, and every one of them a place to be wrong. -->
        <div v-if="open && body === `drawer`" :id="bodyId" class="border-t border-line-subtle" :class="DRAWER_PAD[density]">
            <slot name="below" />
        </div>
    </div>
</template>
