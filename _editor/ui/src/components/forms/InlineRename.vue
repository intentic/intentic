<!-- The app's one rename: a name that reads as text, a field in that same text's box, Enter/Esc/blur. -->
<script setup lang="ts">
import { computed, type CSSProperties, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import Icon from "../primitives/Icon.vue";
import { createInlineRename } from "../../composables/inlineRename.js";
import { useT } from "../../i18n/index.js";
import { placeAnchored } from "../../lib/anchorPlacement.js";
import { ui } from "../../lib/ui.js";

const t = useT();

// NOTHING ENTERS OR LEAVES THE ROW WHEN THE MODE CHANGES, which is the whole point of the component: the resting
// name, the field and the one-glyph slot beside them occupy the same boxes in every state, so no neighbour moves,
// no line appears under the title and the surface keeps its height from rest through saving to failure.
// Type is the caller's: pass it on this element (`text-lg font-semibold`) and both the text and the field inherit it.

const {
    value,
    write,
    label,
    action = `Rename`,
    fallback = `Unnamed`,
    editable = true,
    maxlength = 80,
    failure = `Couldn't save that name.`,
} = defineProps<{
    /** The name as it stands. Empty or absent draws `fallback` instead, and starts the field empty. */
    value: string | undefined;
    /** Where a committed name goes. Throwing is how it reports failure; the field stays open with the draft in it. */
    write: (name: string) => Promise<void>;
    /** Names the field for assistive tech, in the words of what is being renamed ("Sandbox name"). */
    label: string;
    /** The rename affordance's tooltip, and what the resting control adds to its own name ("Rename sandbox"). */
    action?: string;
    /** Drawn, muted, where there is no name yet. */
    fallback?: string;
    /** False renders the name as plain text: no press target, no pencil, no slot. */
    editable?: boolean;
    maxlength?: number;
    /** What to say when the write fails, in the words of whatever is being renamed. */
    failure?: string;
}>();

const rename = createInlineRename(
    () => value,
    (name) => write(name),
    failure,
);

const shown = computed(() => {
    const named = value?.trim() ?? ``;
    return named === `` ? fallback : named;
});
const unnamed = computed(() => (value?.trim() ?? ``) === ``);

const field = useTemplateRef<HTMLInputElement>(`field`);
const chip = useTemplateRef<HTMLElement>(`chip`);
// Teleported and fixed, against the field's OWN window: this control is dropped into row groups and cards that clip,
// and a refusal that renders inside one is cut in half on the last row of the list. Measured with the kit's own
// placement so it flips above the field near the bottom edge and never leaves the window.
const at = ref<CSSProperties>({ transform: `translate(-200vw, -200vh)` });
const place = (): void => {
    const anchor = field.value;
    const box = chip.value;
    if (anchor === null || box === null) {
        return;
    }
    const view = anchor.ownerDocument.defaultView;
    if (view === null) {
        return;
    }
    const placed = placeAnchored({
        anchor: anchor.getBoundingClientRect(),
        box: box.getBoundingClientRect(),
        view: { width: view.innerWidth, height: view.innerHeight },
        side: `bottom`,
        cross: `start`,
        gap: 4,
        edge: 8,
    });
    at.value = { left: `${Math.round(placed.left)}px`, top: `${Math.round(placed.top)}px` };
};

// Armed only while a refusal is on screen, on the field's own document, so a popped-out panel tracks its own scroll.
let armed: { readonly doc: Document; readonly view: Window } | undefined;
const disarm = (): void => {
    armed?.doc.removeEventListener(`scroll`, place, true);
    armed?.view.removeEventListener(`resize`, place);
    armed = undefined;
};
watch(
    () => rename.error,
    async (message) => {
        disarm();
        at.value = { transform: `translate(-200vw, -200vh)` };
        if (message === undefined) {
            return;
        }
        // A failed write leaves the field open; putting the caret back is what makes the retry a keystroke rather
        // than a hunt for where the name went.
        field.value?.focus();
        await nextTick();
        place();
        const doc = field.value?.ownerDocument;
        const view = doc?.defaultView;
        if (doc === undefined || view === null || view === undefined) {
            return; // Unmounted between the refusal and this tick; nothing left to follow.
        }
        doc.addEventListener(`scroll`, place, true);
        view.addEventListener(`resize`, place);
        armed = { doc, view };
    },
    { flush: `post` },
);
onBeforeUnmount(disarm);
</script>

<template>
    <span class="group/rename flex min-w-0 items-center gap-1">
        <!-- One grid cell holds every state. The invisible twins size it: the resting name always, the draft while
             it is longer, so the field starts exactly as wide as the text it replaced and only ever grows.
             `size="1"` is load-bearing: a text input's intrinsic width is ~20 characters whatever its CSS width, and
             the cell is sized by its widest item, so without it the field opens a good deal wider than the name. -->
        <span class="grid w-fit min-w-0 max-w-full grid-cols-1 grid-rows-1">
            <span aria-hidden="true" class="invisible col-start-1 row-start-1 whitespace-pre border border-transparent px-1">{{ shown }}</span>
            <span v-if="rename.editing" aria-hidden="true" class="invisible col-start-1 row-start-1 whitespace-pre border border-transparent px-1">{{
                rename.draft
            }}</span>

            <input
                v-if="rename.editing"
                ref="field"
                v-model="rename.draft"
                type="text"
                :aria-label="label"
                :maxlength
                :readonly="rename.busy"
                size="1"
                autocomplete="off"
                spellcheck="false"
                :class="ui.inputInline(`col-start-1 row-start-1 w-full min-w-0 px-1`, rename.error === undefined ? `` : `ui-field-error-box`)"
                @click.stop
                @keydown.enter.stop.prevent="rename.commit()"
                @keydown.esc.stop.prevent="rename.cancel()"
                @blur="rename.blurCommit()"
                @vue:mounted="rename.focusInput"
            />
            <!-- `cursor-text`: the press opens a field here, it does not navigate. The tooltip is the overflowing
                 name, never the verb — the verb rides the pencil, where it cannot displace what the name says. -->
            <button
                v-else-if="editable"
                type="button"
                class="col-start-1 row-start-1 min-w-0 cursor-text truncate rounded-md border border-transparent px-1 text-left transition-colors hover:bg-overlay"
                :class="unnamed ? `text-subtle` : ``"
                v-tooltip.overflow="shown"
                @click.stop="rename.begin()"
            >
                {{ shown }}<span class="sr-only">, {{ action }}</span>
            </button>
            <!-- The same transparent 1px rule the field carries, so text sits on the same pixel in every state. -->
            <span v-else class="col-start-1 row-start-1 min-w-0 truncate border border-transparent px-1" :class="unnamed ? `text-subtle` : ``">{{
                shown
            }}</span>
        </span>

        <!-- The slot is 20px in every state: pencil, then the save key, then the spinner. Half-lit at rest rather
             than hover-only, which a touch screen never discovers. -->
        <template v-if="editable">
            <button
                v-if="rename.editing"
                type="button"
                :class="ui.iconButton(`h-5 w-5`)"
                :disabled="rename.busy"
                :aria-label="t(`ui.action.save`)"
                v-tooltip.top="`Save · Enter`"
                @mousedown.prevent
                @click.stop="rename.commit()"
            >
                <Icon :name="rename.busy ? `spinner` : `check`" :spin="rename.busy" class="text-2xs" />
            </button>
            <!-- Hidden from assistive tech on purpose: it repeats the resting control, which is already focusable
                 and already says the verb. -->
            <button
                v-else
                type="button"
                tabindex="-1"
                aria-hidden="true"
                :class="ui.iconButton(`h-5 w-5`)"
                v-tooltip.top="action"
                @click.stop="rename.begin()"
            >
                <Icon name="pencil" class="text-2xs opacity-60 transition-opacity group-hover/rename:opacity-100" />
            </button>
        </template>

        <!-- Floats: a failure that pushed the page down would move the very thing being renamed. -->
        <Teleport v-if="rename.error !== undefined && field" :to="field.ownerDocument.body">
            <span
                ref="chip"
                role="alert"
                :style="at"
                class="fixed z-30 max-w-64 rounded-md border border-danger/30 bg-card px-2 py-1 text-2xs font-normal leading-snug text-danger shadow-md"
                >{{ rename.error }}</span
            >
        </Teleport>
    </span>
</template>
