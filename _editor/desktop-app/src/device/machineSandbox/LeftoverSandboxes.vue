<!-- THE SANDBOXES THIS COMPUTER LEFT BEHIND: rows of the account it made before it kept one ("<COMPUTER> sandbox 2", "… 3"),
     which nothing runs any more and which only crowd the account's switcher. Offered once, on this page, and taken off the
     account only on the reader's press (the platform's trash keeps each a week); the app never removes one by itself.
     Which rows count is machine_sandbox.rs `leftovers`: named the old way for this computer, run nowhere for a day. -->
<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { Button, ConfirmDialog, Icon, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, watch } from "vue";
import { type LeftoverSandbox, machineSandboxLeftovers, machineSandboxRemoveLeftovers } from "../../desktop";

const { signedIn } = defineProps<{
    /** Someone is signed in: the account's list is only theirs to read. */
    signedIn: boolean;
}>();

const t = useT();
const leftovers = ref<readonly LeftoverSandbox[]>([]);
const confirming = ref(false);
const removing = ref(false);
const failure = ref<string | undefined>(undefined);

// Read on arrival and on a sign-in; a read that fails is nothing to offer, never an error to show.
const read = async (): Promise<void> => {
    if (!signedIn) {
        leftovers.value = [];
        return;
    }
    try {
        leftovers.value = await machineSandboxLeftovers();
    } catch (error) {
        console.error(`[device] the sandboxes this computer left behind could not be read:`, error);
        leftovers.value = [];
    }
};
onMounted(() => void read());
watch(
    () => signedIn,
    () => void read(),
);

const names = computed(() => leftovers.value.map((leftover) => leftover.name).join(`, `));

const remove = async (): Promise<void> => {
    confirming.value = false;
    removing.value = true;
    failure.value = undefined;
    try {
        await machineSandboxRemoveLeftovers(leftovers.value.map((leftover) => leftover.id));
    } catch (error) {
        failure.value = errorMessage(error);
    } finally {
        removing.value = false;
        await read();
    }
};
</script>

<template>
    <section v-if="leftovers.length > 0 || failure !== undefined" class="flex flex-col gap-2 rounded-xl bg-card p-4 shadow-sm">
        <div v-if="leftovers.length > 0" class="flex items-start gap-2.5">
            <Icon name="box" class="mt-0.5 shrink-0 text-subtle" />
            <div class="min-w-0 flex-1">
                <p class="text-sm leading-tight font-semibold">{{ t(`desktop.leftovers.title`, { count: leftovers.length }, leftovers.length) }}</p>
                <p class="mt-1 max-w-read-sm text-xs leading-relaxed text-muted">{{ t(`desktop.leftovers.detail`, { names }) }}</p>
            </div>
            <Button size="small" tier="boring" class="-my-1 shrink-0" :label="t(`desktop.leftovers.remove`)" :loading="removing" @click="confirming = true" />
        </div>
        <Notice v-if="failure !== undefined" tone="danger" class="text-xs">{{ failure }}</Notice>
        <ConfirmDialog
            :open="confirming"
            :header="t(`desktop.leftovers.confirmHeader`, { count: leftovers.length }, leftovers.length)"
            :confirm-label="t(`desktop.leftovers.remove`)"
            confirm-icon="trash"
            :description="t(`desktop.leftovers.confirmDetail`, { names })"
            @cancel="confirming = false"
            @confirm="remove"
        />
    </section>
</template>
