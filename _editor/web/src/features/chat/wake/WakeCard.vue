<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted } from "vue";
import { CALLED_MS, type WakeListener } from "./useWakeListener";
import { GLANCE_MS, type WakeDelivery } from "./wakeDelivery";
import { destinationLabel } from "./wakeWords";

// The one card the wake listener draws, at the top of the window where an eye lifted from anything finds it: the words
// it heard and where they are bound, for the moment before they go (send now, send them to the other place, or drop
// them with Escape); the name heard alone, while it waits for the request; and where the words went, for a moment after.

const t = useT();

const props = defineProps<{ listener: WakeListener; delivery: WakeDelivery }>();
const emit = defineEmits<{ open: [id: string] }>();

const now = useNow(true, 100);
const pending = computed(() => props.delivery.pending.value);
const sent = computed(() => props.delivery.sent.value);
const called = computed(() => pending.value === undefined && props.listener.mode.value === `called` && props.listener.modeUntil.value !== undefined);

const word = computed(() => props.listener.word.value);

// How much of the moment is left, 1 → 0: the bar under the card empties as it runs out.
const left = (until: number | undefined, span: number): number => (until === undefined ? 0 : Math.max(0, Math.min(1, (until - now.value) / span)));
const pendingLeft = computed(() => left(pending.value?.until, GLANCE_MS));
const calledLeft = computed(() => left(props.listener.modeUntil.value, CALLED_MS));

const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape` && pending.value !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        props.delivery.cancel();
    }
};
onMounted(() => window.addEventListener(`keydown`, onKey, { capture: true }));
onBeforeUnmount(() => window.removeEventListener(`keydown`, onKey, { capture: true }));
</script>

<template>
    <div class="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-3" aria-live="polite">
        <Transition
            enter-active-class="transition duration-150 ease-out"
            enter-from-class="-translate-y-2 opacity-0"
            leave-active-class="transition duration-150 ease-in"
            leave-to-class="-translate-y-2 opacity-0"
        >
            <section
                v-if="pending !== undefined"
                role="dialog"
                :aria-label="t(`chat.wake.heardLabel`, { word })"
                class="pointer-events-auto relative w-full max-w-md overflow-hidden rounded-xl border border-line-strong bg-card shadow-lg"
                data-wake="pending"
            >
                <div class="flex flex-col gap-2 p-3">
                    <p class="flex items-center gap-1.5 text-2xs text-muted">
                        <Icon name="microphone" class="text-primary-500" />{{ t(`chat.wake.heardLabel`, { word }) }}
                    </p>
                    <p class="line-clamp-3 text-sm text-content">“{{ pending.text }}”</p>
                    <p class="flex min-w-0 items-center gap-1.5 text-xs font-medium text-content">
                        <Icon :name="pending.to.route.kind === `new` ? `plus` : `comments`" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 truncate">{{ destinationLabel(pending.to) }}</span>
                    </p>
                    <div class="flex flex-wrap items-center gap-1.5">
                        <Button size="small" thumb @click="delivery.sendNow">{{ t(`chat.wake.sendNow`) }}</Button>
                        <Button v-if="pending.instead !== undefined" size="small" thumb tier="quiet" @click="delivery.switchRoute">
                            {{ t(`chat.wake.instead`, { destination: destinationLabel(pending.instead) }) }}
                        </Button>
                        <Button size="small" thumb tier="quiet" class="ml-auto" @click="delivery.cancel">{{ t(`chat.wake.cancel`) }}</Button>
                    </div>
                </div>
                <div class="absolute inset-x-0 bottom-0 h-0.5 bg-primary-500/70 transition-[width] duration-100 ease-linear" :style="{ width: `${pendingLeft * 100}%` }"></div>
            </section>

            <section
                v-else-if="called"
                role="status"
                class="pointer-events-auto relative flex items-center gap-2 overflow-hidden rounded-full border border-line-strong bg-card px-3.5 py-2 text-xs text-content shadow-lg"
                data-wake="called"
            >
                <Icon name="microphone" class="animate-pulse text-primary-500" />
                {{ t(`chat.wake.called`, { word }) }}
                <div class="absolute inset-x-0 bottom-0 h-0.5 bg-primary-500/70" :style="{ width: `${calledLeft * 100}%` }"></div>
            </section>

            <!-- A chip floating over the page: the card's last word, and the way to the conversation it went to. -->
            <button
                v-else-if="sent !== undefined"
                type="button"
                class="ui-chip pointer-events-auto max-w-md min-w-0 bg-card shadow-lg"
                data-wake="sent"
                @click="emit(`open`, sent.id)"
            >
                <Icon name="check" class="shrink-0 text-success" />
                <span class="min-w-0 truncate">{{ t(`chat.wake.sentTo`, { destination: destinationLabel(sent.to) }) }}</span>
                <span class="shrink-0 text-muted">{{ t(`chat.wake.open`) }}</span>
            </button>
        </Transition>
    </div>
</template>
