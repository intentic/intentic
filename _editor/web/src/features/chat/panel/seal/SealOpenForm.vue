<!-- OPENING A PRIVATE CONVERSATION WITHOUT ASKING, the sandbox owner's one door past a seal, unfolded under the gate's
     quiet press: the reason they must give, what it buys (read-only, for a day), that the author is told now, and that the
     reason stays on the conversation for good. Confirmed with the owner's passkey (sealPresses.openWithoutAsking); with
     none to sign with, the way on is Access ▸ Sign-in. -->
<script setup lang="ts">
import { SEAL_OPEN_HOURS, SEAL_REASON_MAX, SEAL_REASON_MIN } from "@intentic/sandbox-contract/schemas/seal";
import { Button, ui } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { formatUntil } from "@intentic/ui/time";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { accessPath } from "../../../../models/sandbox/sandboxNav";
import { NoPasskeyError, openWithoutAsking } from "../../../../models/fleet/presses/sealPresses";
import { useSealHouse } from "../../../../models/conversations/seal/useSealHouse";

const t = useT();

const { conversationId, author } = defineProps<{
    conversationId: string;
    /** The author as a sentence names them. */
    author: string;
}>();
const emit = defineEmits<{ cancel: [] }>();

const { house } = useSealHouse();

const reason = ref(``);
const length = computed(() => reason.value.trim().length);
const ready = computed(() => length.value >= SEAL_REASON_MIN && length.value <= SEAL_REASON_MAX);
// A day from the press, as the daemon counts it (from the second person's yes, where one is needed).
const until = computed(() => formatUntil(Date.now() + SEAL_OPEN_HOURS * 3_600_000));

const busy = ref(false);
const failure = ref<string>();
const noPasskey = ref(false);
const confirm = async (): Promise<void> => {
    if (!ready.value || busy.value) {
        return;
    }
    busy.value = true;
    failure.value = undefined;
    noPasskey.value = false;
    try {
        await openWithoutAsking(conversationId, reason.value.trim());
    } catch (error) {
        noPasskey.value = error instanceof NoPasskeyError;
        failure.value = noPasskey.value ? undefined : messageOr(error, t(`chat.seal.open.failed`));
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <form class="flex w-full flex-col gap-3" data-seal-open-form @submit.prevent="confirm">
        <label class="flex flex-col gap-1">
            <span class="ui-field-label">{{ t(`chat.seal.open.reason`) }}</span>
            <!-- Enter breaks the line; Ctrl+Enter (⌘+Enter) is Confirm's, as in every field with a button beside it. -->
            <textarea
                v-model="reason"
                rows="3"
                autofocus
                :maxlength="SEAL_REASON_MAX"
                :class="ui.input()"
                class="w-full"
                :placeholder="t(`chat.seal.open.reasonPlaceholder`, { name: author })"
                @keydown.ctrl.enter.prevent="confirm"
                @keydown.meta.enter.prevent="confirm"
            ></textarea>
            <span class="text-2xs text-subtle">{{ t(`chat.seal.open.reasonHint`, { min: SEAL_REASON_MIN, count: length, max: SEAL_REASON_MAX }) }}</span>
        </label>

        <!-- What it buys and what it costs, as the label/value pairs a settings block reads in. -->
        <dl class="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
            <dt class="text-muted">{{ t(`chat.seal.open.for`) }}</dt>
            <dd class="text-content">{{ t(`chat.seal.open.readOnlyUntil`, { until }) }}</dd>
            <dt class="truncate text-muted">{{ author }}</dt>
            <dd class="text-content">{{ t(`chat.seal.open.isTold`) }}</dd>
        </dl>
        <p class="text-xs leading-relaxed text-muted">
            {{ t(`chat.seal.open.forGood`, { name: author }) }}
            <template v-if="house?.twoPerson === true"> {{ t(`chat.seal.open.twoPerson`) }}</template>
        </p>

        <p v-if="noPasskey" role="alert" class="text-xs text-warning">
            {{ t(`chat.seal.open.noPasskey`) }}
            <RouterLink :to="accessPath(`sign-in`)" class="font-medium text-link underline">{{ t(`chat.seal.open.addPasskey`) }}</RouterLink>
        </p>
        <p v-if="failure !== undefined" role="alert" class="text-xs text-danger">{{ failure }}</p>

        <div class="flex flex-wrap items-center justify-end gap-2">
            <Button tier="quiet" :disabled="busy" @click="emit(`cancel`)">{{ t(`ui.action.cancel`) }}</Button>
            <Button type="submit" tier="accent" tone="danger" class="whitespace-nowrap" :label="t(`chat.seal.open.confirm`)" :loading="busy" :disabled="!ready || busy">
                <template #icon><Icon name="key" /></template>
            </Button>
        </div>
    </form>
</template>
