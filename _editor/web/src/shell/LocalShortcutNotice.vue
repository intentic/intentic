<script setup lang="ts">
import { Icon } from "@intentic/ui";
import Button from "primevue/button";
import { useLocalShortcut } from "../composables/sandbox/localShortcut";
import { useEndpoint } from "../composables/sandbox/useEndpoint";

/* THE ONE SENTENCE THAT HAS TO COME BEFORE THE BROWSER'S OWN DIALOG.
 *
 * The reasoning for asking at all is in composables/sandbox/localShortcut.ts. What is decided HERE is how it
 * reads, and the whole design is that it must not look like the thing it is about to cause.
 *
 * SO IT IS A RECEIPT, NOT AN ALERT. Same lane, same pill vocabulary as ReceiptBar — because this is an offer,
 * and dressing an offer as a warning is how an app teaches people that yes is the dangerous answer. The push
 * notice next door is red and centred at the top of the viewport; that one is a decision the user already owes
 * about work they already did. This one is a nicety they never asked for, and it is allowed to be missed.
 *
 * IT NAMES THE BENEFIT AND THE COST IN THAT ORDER, in two short lines: why anyone would want this, then what
 * is about to appear on screen if they say yes. The second line exists solely so that the browser's dialog —
 * which will talk about devices on their local network, and will not mention sandboxes, speed, or us — is
 * recognisable as the answer to this card rather than an interruption from nowhere.
 *
 * IT DOES NOT EXPIRE, unlike its neighbours in this lane. A receipt retires because nothing depends on being
 * read; this one is a question, and a question that times out is a decision nobody made. Both answers are
 * remembered, so it is asked at most once — and No costs the user nothing, because the address it declines is
 * an optimisation on top of one that already works. */

const { question, allow, decline } = useLocalShortcut();
const { resolve } = useEndpoint();

/* Yes — and probe immediately rather than leaving it to the next reconnect, for two reasons. This is the one
 * moment the user is thinking about the question, so the browser's own dialog lands while the card that
 * explains it is still on screen. And the fetch happens inside their click, which is the friendliest moment
 * there is to ask a browser for anything. */
const accept = (): void => {
    allow();
    void resolve().catch(() => undefined);
};

const refuse = (): void => {
    const sandboxId = question.value;
    if (sandboxId !== undefined) {
        decline(sandboxId);
    }
};
</script>

<template>
    <!-- The wrapper is inert; only the card takes the pointer, so this never eats a click on the workspace
         underneath. Seated above the receipt lane rather than in it — a receipt raised while this is waiting
         must not land on top of the question. -->
    <Transition name="shortcut">
        <div v-if="question !== undefined" class="pointer-events-none fixed inset-x-0 bottom-16 z-50 flex justify-center px-3">
            <!-- Announced, not focus-trapped. It interrupts nothing and can be ignored, so taking the keyboard
                 away from whatever the user was typing into would be a bigger imposition than the browser
                 dialog this card exists to soften. -->
            <div
                class="pointer-events-auto flex max-w-full items-start gap-2 rounded-lg border border-line-strong bg-card px-3 py-2 shadow-lg"
                aria-live="polite"
            >
                <Icon name="bolt" class="mt-0.5 shrink-0 text-2xs text-link" />
                <div class="min-w-0">
                    <p class="text-xs font-medium text-content">Faster if this sandbox runs on this computer.</p>
                    <p class="mt-0.5 text-2xs text-muted">Your browser will ask to allow it.</p>
                </div>
                <div class="flex shrink-0 items-center gap-1 self-center">
                    <Button label="No" severity="secondary" text size="small" @click="refuse" />
                    <Button label="Allow" size="small" @click="accept" />
                </div>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
/* The receipt lane's own motion, so the two read as one channel. */
.shortcut-enter-active,
.shortcut-leave-active {
    transition:
        transform 200ms ease,
        opacity 200ms ease;
}
.shortcut-enter-from,
.shortcut-leave-to {
    opacity: 0;
    transform: translateY(0.5rem);
}
</style>
