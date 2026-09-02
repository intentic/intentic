<script setup lang="ts">
import { Button, Modal, Row } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { ref, watch } from "vue";

/* THE ONE DECISION AN EXPORT ASKS FOR, ASKED WHEN SOMEBODY ASKS FOR AN EXPORT.
 *
 * It used to be a switch standing on the card: "Put secrets in the bundle", lit whether or not anyone was
 * exporting anything, sitting under the button rather than behind it. Read cold that is a SETTING — a property
 * of this sandbox, like a preference — and it is nothing of the kind: it is one argument to one POST,
 * remembered by no one, meaning nothing at all between clicks. So the switch was wrong twice over. A reader who
 * flipped it and walked away had changed no state and would never learn that; a reader who pressed Export
 * without looking below it had answered a question they never saw, and the answer decides whether the file that
 * lands is safe to hand to anybody.
 *
 * A MODAL IS THE HONEST SHAPE FOR A PER-EXPORT ARGUMENT. It exists for the length of the decision, it cannot be
 * missed by the person taking it, and it puts the consequence next to the button that commits it. The old card
 * had to spell the danger out in standing prose precisely BECAUSE the control was standing prose's neighbour;
 * here the sentence appears when the lock opens and goes away when it shuts.
 *
 * IT STARTS LOCKED EVERY TIME, and that is the reason the state lives here rather than on the card. A bundle
 * with credentials in it is the exception, so the exception is re-consented to per export instead of inherited
 * from whatever the last one did. Watching `open` rather than resetting on close: a dialog dismissed mid-thought
 * (Esc, the mask) has to come back the same as a fresh one. */

const { open, busy = false } = defineProps<{
    open: boolean;
    /** Held while the daemon names the bundle: the pack itself outlives this dialog and reports on the card. */
    busy?: boolean;
}>();

const emit = defineEmits<{ cancel: []; confirm: [secrets: boolean] }>();

const secrets = ref(false);
watch(
    () => open,
    (showing) => {
        if (showing) {
            secrets.value = false;
        }
    },
);
</script>

<template>
    <Modal :open="open" size="sm" header="Export environment" @update:open="emit(`cancel`)">
        <div class="flex flex-col gap-4">
            <!-- WHAT THE BUTTON IS ABOUT TO DO, in the two facts a reader needs before answering the question
                 below: what goes in, and that the answer arrives later rather than now. Packing a real
                 workspace takes minutes, and a dialog that closes onto an apparently idle card is how "did my
                 export start?" gets asked. -->
            <p class="text-xs text-subtle">
                Packs this sandbox's definition together with the bytes nothing can reference: transcripts, checkpoints, unpushed branches. It is
                built on the sandbox and appears under <span class="font-medium text-content">Exports</span> when it is done, so you can close this
                tab while it runs.
            </p>

            <!-- The lock is the state at a glance: it opens and goes warning-coloured the moment the bundle
                 stops being safe to hand over, so the danger is legible before the sentence is read.
                 A bordered box rather than a full-bleed band — a modal's body padding is PrimeVue's, not a
                 number this file may assume, and a negative margin guessed against it is how a control ends up
                 two pixels past the edge it was aiming for. -->
            <div class="overflow-hidden rounded-lg border border-line">
                <Row
                    flush
                    as="label"
                    density="compact"
                    :icon="secrets ? `unlock` : `lock`"
                    :tone="secrets ? `warning` : `default`"
                    title="Include the secret values"
                    class="cursor-pointer px-3.5 py-3"
                >
                    <template #description>
                        Keys, tokens and stored logins, written into the file in the clear. Leave it off and the bundle carries secret names only, and
                        whoever brings it in fills the values.
                    </template>
                    <template #control>
                        <ToggleSwitch v-model="secrets" />
                    </template>
                    <!-- `v-if` ON THE SLOT, not on a <p> inside it: a slot that is passed is a slot the row
                         renders, margin and all. -->
                    <template v-if="secrets" #below>
                        <p class="text-2xs text-warning">Store the file like a password, and delete it once it has landed on the other side.</p>
                    </template>
                </Row>
            </div>
        </div>

        <template #footer>
            <Button label="Cancel" severity="secondary" :text="true" @click="emit(`cancel`)" />
            <!-- THE BUTTON SAYS WHICH EXPORT IT IS. A confirm whose label does not change with the switch above
                 it leaves the switch as the only record of the choice, which is the failure this dialog exists
                 to fix — one step closer to the commit. `warn` rather than `danger`: it destroys nothing, it
                 writes a file that has to be handled like a key. -->
            <Button
                :label="secrets ? `Export with secrets` : `Export`"
                :severity="secrets ? `warn` : undefined"
                autofocus
                :loading="busy"
                @click="emit(`confirm`, secrets)"
            >
                <template #icon><Icon name="box" /></template>
            </Button>
        </template>
    </Modal>
</template>
