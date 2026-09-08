<script setup lang="ts">
import { Button, Modal, Row } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { ref, watch } from "vue";

// Whether to include secrets is a per-export argument, not a sandbox setting, so it lives in this modal next to the
// button that commits it rather than as a standing switch on the card. Starts locked every time; watches `open`, not
// `close`, so a mid-dismiss (Esc, mask) comes back the same as fresh.

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
            <!-- What goes in, and that the result arrives later: packing takes minutes, so closing this dialog must not read as nothing happened. -->
            <p class="text-xs text-subtle">
                Packs this sandbox's definition together with the bytes nothing can reference: transcripts, checkpoints, unpushed branches. It is
                built on the sandbox and appears under <span class="font-medium text-content">Exports</span> when it is done, so you can close this
                tab while it runs.
            </p>

            <!--
                Lock opens and turns warning-colored exactly when the bundle becomes unsafe to hand over. Bordered box, not a negative margin against
                the modal's padding (PrimeVue's, not a number to assume).
            -->
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
                    <!-- `v-if` on the slot itself, not a `<p>` inside it: a passed slot is one the row renders, margin included. -->
                    <template v-if="secrets" #below>
                        <p class="text-2xs text-warning">Store the file like a password, and delete it once it has landed on the other side.</p>
                    </template>
                </Row>
            </div>
        </div>

        <template #footer>
            <Button label="Cancel" severity="secondary" :text="true" @click="emit(`cancel`)" />
            <!--
                Label mirrors the switch, so the confirm carries the choice too, not just the switch. `warn`, not `danger`: it destroys nothing, just
                writes a file to handle like a key.
            -->
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
