<!-- THE QUIET HALF OF THE APP'S FEEDBACK: what just happened, said once, gone on its own.
     One host for the whole app (both shells mount it), so a completion reported from a dialog, a tree row or a
     settings card all arrive in the same place and look like the same product. The STORE is composables/
     receipts.ts; what lives here is the timing, because the timing depends on the pointer:

     A receipt PAUSES while hovered. Vanishing under the cursor that came for its Undo would fail the
     affordance at the only moment it is ever wanted: the board found this first, and it is the reason expiry
     is a view's business rather than the store's.

     The window restarts on each new receipt (the watch reads the ref itself, so replacing it re-arms the full
     dwell) and the announcement is made once per receipt, since the pill is the visual half of a report a
     screen reader cannot see at all. -->
<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { onBeforeUnmount, ref, watch } from "vue";
import { useReceipts } from "../composables/receipts";

// Long enough to read a short sentence and reach for the Undo, short enough that it reads as "that just
// happened" rather than as a new thing on screen. The board's figure, kept: it was arrived at honestly.
const RECEIPT_MS = 7_000;
// A problem gets longer, because its sentence is longer and it is doing more work: a completion confirms
// something the user already expected, while this one is telling them why the thing they asked for did not
// arrive, and if it expires unread they are back to a button that did nothing.
const PROBLEM_MS = 12_000;

const { receipt, dismissReceipt } = useReceipts();
const hovered = ref(false);
const announcement = ref(``);
let timer: ReturnType<typeof setTimeout> | undefined;

watch([receipt, hovered], () => {
    clearTimeout(timer);
    if (receipt.value === undefined) {
        return;
    }
    announcement.value = receipt.value.message;
    if (!hovered.value) {
        timer = setTimeout(dismissReceipt, receipt.value.tone === `problem` ? PROBLEM_MS : RECEIPT_MS);
    }
});

onBeforeUnmount(() => clearTimeout(timer));

// An Undo retires the receipt it belongs to: the thing it was reporting is no longer true.
const undo = (): void => {
    const action = receipt.value?.undo;
    dismissReceipt();
    void action?.();
};
</script>

<template>
    <!-- The wrapper is inert; only the pill takes the pointer, or a receipt would eat clicks on whatever it
         floats over. -->
    <Transition name="receipt">
        <div v-if="receipt !== undefined" class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-3">
            <div
                class="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-line-strong bg-card py-1.5 pl-3 pr-2 text-2xs text-muted shadow-lg"
                @mouseenter="hovered = true"
                @mouseleave="hovered = false"
            >
                <!-- One glyph and one colour apart from a completion, which is the whole of the difference:
                     the pill is the same object saying a different thing, not an alarm wearing its clothes. -->
                <Icon
                    :name="receipt.tone === `problem` ? `exclamation-circle` : `check`"
                    class="shrink-0 text-2xs"
                    :class="receipt.tone === `problem` ? `text-warning` : `text-success`"
                />
                <!-- A completion is three words and truncating it never bites; a problem has to say what and
                     why, so it wraps to a second line instead of ending in an ellipsis mid-reason. -->
                <span class="min-w-0" :class="receipt.tone === `problem` ? `line-clamp-2 max-w-[28rem]` : `truncate`">{{ receipt.message }}</span>
                <button
                    v-if="receipt.undo !== undefined"
                    type="button"
                    class="shrink-0 cursor-pointer rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15"
                    @click="undo"
                >
                    Undo
                </button>
            </div>
        </div>
    </Transition>
    <!-- What the pill cannot tell a screen reader. Polite: a completion never interrupts. -->
    <span class="sr-only" aria-live="polite">{{ announcement }}</span>
</template>

<style scoped>
/* Rises into place and sinks out of it: the same direction both ways, so one that expires on its own and one
 * dismissed by an Undo read as the same object leaving. */
.receipt-enter-active,
.receipt-leave-active {
    transition:
        transform 200ms ease,
        opacity 200ms ease;
}
.receipt-enter-from,
.receipt-leave-to {
    opacity: 0;
    transform: translateY(0.5rem);
}
</style>
