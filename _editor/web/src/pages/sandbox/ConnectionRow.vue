<script setup lang="ts">
import { Row } from "@intentic/ui";
import { nextTick, ref, useTemplateRef } from "vue";
import UsageRing from "../../components/UsageRing.vue";
import type { PlanHeadroom } from "../../composables/chat/usageStatus";

/* ONE connection row. Every credential the Agent tab can hold renders through this: a native provider account,
 * a translator subscription, the "you have none yet" placeholder and the "add another" invitation alike, so
 * they cannot drift into looking like different kinds of thing. They are not: each one answers "what am I
 * signed in with, and what can I do about it?".
 *
 * The anatomy, left to right, is fixed:
 *   · a status GLYPH in a fixed-width well (dot, or the plus of an add-row), so every title starts on the
 *     same x, whatever the row is
 *   · the connection's NAME, which is EDITABLE IN PLACE where the sandbox owns the credential (`renamable`).
 *     A name is not a setting hidden behind a menu: the thing you want to change is right there on screen, so
 *     you change it there. It is also the only answer for a connection whose provider hands back no identity to
 *     derive a name from: without it, a second one is a second row saying nothing but the provider's name.
 *   · its STATE, in the same small type, in the same place, for every provider ("not connected", the signed-in
 *     identity, "signing in…")
 *   · the ACTION, in #control: one of them, except on a credential that has gone bad, where repairing it and
 *     dropping it are genuinely two different answers
 *   · the live sign-in, in #below, inside this row's hairline rather than in a panel detached from it
 *
 * `state` drives only the glyph and the tone: never the layout, which is what lets a row change state
 * (missing → signing-in → connected) without anything moving. */

const {
    title,
    state,
    activity,
    headroom,
    interactive = false,
} = defineProps<{
    title: string;
    // `unknown` is the honest first frame: the daemon hasn't answered, so the dot must not claim either way.
    state: `connected` | `reauth` | `missing` | `unknown` | `add`;
    // The state line beside the title (the signed-in identity, "not connected", "signing in…").
    note?: string;
    // Whether `note` is a live wait, which earns it a spinner: the one moving thing in the row.
    noteBusy?: boolean;
    // The half-sentence under the title: what this connection costs / what it runs / why it needs reconnecting.
    description?: string;
    // The description is coming from a read that hasn't landed. Holds the line's height with a bar rather than
    // letting it appear afterwards: the name arrives with the connections and the usage a request later, and a
    // second line materialising under a row already on screen pushes every row below it down.
    descriptionPending?: boolean;
    tone?: `default` | `warning`;
    interactive?: boolean;
    // Whether this connection's name is the user's to change: true only where the sandbox owns the credential.
    renamable?: boolean;
    // This account's plan limits, when they have been read. Replaces the plain dot with a ring (and the card
    // that opens beside it) so the headroom is visible at a glance. Undefined = no reading, and the dot stays.
    headroom?: PlanHeadroom;
    /* What this sandbox has spent on the connection. It belongs INSIDE the ring's card, not on the row: the
     * row answers "which account is this and can I use it", and a permanent line of turns/tokens/dollars under
     * every row answered a question nobody had while making that one harder to read. When there is no ring
     * (providers whose plan limits cannot be read, such as Cursor and Grok), the figures are omitted here:
     * the Usage tab holds that history, and printing it under every connection row was the clutter this split
     * was meant to remove. */
    activity?: string;
    // Whether this account is exhausted (≥90% utilization). Dims the row so active accounts stand out.
    exhausted?: boolean;
}>();

const emit = defineEmits<{ rename: [label: string] }>();

/* Renaming, in place. Committing on ENTER and on BLUR (rather than only on an explicit Save button) is what
 * keeps this from being a form: you click the name, you type, you click away, it's named. Escape restores what
 * was there: the one thing a click-away commit needs, so leaving the field can never be a mistake you can't
 * take back. A value equal to the current title emits nothing, so a stray click through the name is free. */
const editing = ref(false);
const draft = ref(``);
const input = useTemplateRef<HTMLInputElement>(`nameInput`);

const startEditing = (): void => {
    draft.value = title;
    editing.value = true;
    void nextTick(() => input.value?.select());
};

const commit = (): void => {
    if (!editing.value) {
        return;
    }
    editing.value = false;
    if (draft.value.trim() !== title) {
        emit(`rename`, draft.value.trim());
    }
};

const cancel = (): void => {
    editing.value = false;
};

const DOT_TONE: Record<string, string> = {
    connected: `bg-success`,
    reauth: `bg-warning`,
    missing: `bg-content/25`,
    // Pulsing, because it is not a verdict: something is still being read.
    unknown: `bg-content/25`,
};
</script>

<template>
    <Row :interactive="interactive" :class="[tone === `warning` ? `bg-warning/10` : ``, exhausted ? `opacity-50` : ``]">
        <template #title>
            <!-- Wraps rather than truncates: the connection KIND has to stay first (a Grok subscription row must
                 never read as the native account above it), with the identity beside it. -->
            <span class="flex min-w-0 flex-wrap items-center gap-x-2.5" :class="state === `add` ? `text-muted` : ``">
                <span class="flex w-[1.125rem] shrink-0 justify-center">
                    <Icon v-if="state === `add`" name="plus" class="text-2xs" />
                    <!-- A ring replaces the dot when usage data is available: the account's headroom is worth
                         more than a binary "connected" dot, and the ring carries the same color system (green /
                         yellow / red) so the meaning is consistent. Hovering it opens the pool-by-pool card,
                         spilling LEFT into the page gutter: this ring opens its row, so everything to its right
                         is the row's own name, state and buttons. -->
                    <UsageRing v-else-if="headroom" :headroom="headroom" :activity="activity" flank="left" />
                    <span v-else class="h-1.5 w-1.5 rounded-full" :class="DOT_TONE[state]" />
                </span>
                <!-- The name, as a field you can type in the moment it is renamable. `w-44` rather than the
                     row's full width: an input that spans the row reads as a search box, and the name it is
                     replacing was never that long. -->
                <input
                    v-if="editing"
                    ref="nameInput"
                    v-model="draft"
                    name="connectionName"
                    class="ui-field-box ui-field-inline w-44 min-w-0 px-1.5 py-0.5 text-sm font-semibold"
                    :aria-label="`Rename ${title}`"
                    @keydown.enter="commit"
                    @keydown.esc="cancel"
                    @blur="commit"
                />
                <!-- Not hover-only: a pencil that appears on hover is invisible on touch and undiscoverable
                     anywhere, which is how this card ended up with no way to name an account at all. It sits at
                     half strength beside the name and comes up to full on hover. The "Rename" hint rides the
                     PENCIL, not the name: hovering an account's name should offer to finish reading it (the
                     `.overflow` tooltip, which only appears when the name is actually cut off), not pop a label
                     about editing over the row above every time the pointer crosses it. -->
                <button
                    v-else-if="renamable"
                    type="button"
                    class="group/name flex min-w-0 cursor-pointer items-center gap-1.5 text-left"
                    @click="startEditing"
                >
                    <span class="min-w-0 truncate" v-tooltip.overflow="title">{{ title }}</span>
                    <Icon
                        name="pencil"
                        class="shrink-0 text-2xs text-subtle opacity-50 transition-opacity group-hover/name:opacity-100"
                        v-tooltip.top="`Rename`"
                    />
                </button>
                <span v-else class="min-w-0 truncate" v-tooltip.overflow="title">{{ title }}</span>
                <span v-if="note && !editing" class="flex items-center gap-1 text-2xs font-normal text-subtle">
                    <Icon v-if="noteBusy" name="spinner" spin />{{ note }}
                </span>
            </span>
        </template>
        <!-- Indented to the title's x, not the glyph's: the description belongs to the name above it. A bar of
             the same line's height stands in while the read behind it is still out, so the row is its final
             height from the first frame. -->
        <template v-if="description || descriptionPending" #description>
            <span v-if="descriptionPending" class="flex min-h-[1lh] items-center pl-7" aria-hidden="true">
                <span class="skeleton block h-2.5 w-56" />
            </span>
            <span v-else class="block pl-7" :class="tone === `warning` ? `text-warning` : ``">{{ description }}</span>
        </template>
        <template v-if="$slots[`control`]" #control><slot name="control" /></template>
        <template v-if="$slots[`below`]" #below><slot name="below" /></template>
    </Row>
</template>
