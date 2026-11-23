<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { lessMotion } from "@intentic/ui/motion";
import { toneWash } from "@intentic/ui/tone";
import { computed, onMounted, useTemplateRef } from "vue";
import type { LandedCard } from "./providerGrid";

// WHAT JUST CONNECTED HERE, as an arrival rather than a line of text: a tick drawn in, the panel's row washed in the
// success tone for a moment, who signed in and where it can now be used, and the one next move. A sign-in that sent the
// reader to the provider's page also says that page is now free to close: it is left open behind this one, and nothing
// else told them they were done with it.

const t = useT();

const { landing, chatLabel } = defineProps<{
    landing: LandedCard;
    // The words on the press, which go to a chat: where that chat is depends on where this page is shown.
    chatLabel?: string | undefined;
}>();
const emit = defineEmits<{ chat: [] }>();

const title = computed(() =>
    landing.refreshed ? t(`connect.landed.refreshedTitle`, { provider: landing.label }) : t(`connect.landed.title`, { provider: landing.label }),
);
const where = computed(() =>
    landing.sandbox === undefined || landing.sandbox === `` ? t(`connect.landed.readyHere`) : t(`connect.landed.readyIn`, { sandbox: landing.sandbox }),
);

// The moment of arrival, washed in and out once on the row this sits in; still under the reduced-motion choice.
const root = useTemplateRef<HTMLElement>(`root`);
onMounted(() => {
    const row = root.value?.parentElement;
    if (row == null || !(`animate` in row) || lessMotion()) {
        return;
    }
    row.animate(
        [{ backgroundColor: `color-mix(in oklab, var(--color-success) 16%, transparent)` }, { backgroundColor: `transparent` }],
        { duration: 1600, easing: `cubic-bezier(0.22, 1, 0.36, 1)` },
    );
});
</script>

<template>
    <div ref="root" class="ui-enter flex flex-col gap-3" role="status">
        <div class="flex flex-wrap items-center gap-3">
            <span :class="toneWash(`success`, `flex size-10 shrink-0 items-center justify-center rounded-full text-base`)">
                <Icon name="check" class="motion-safe:animate-[ui-check-in_320ms_cubic-bezier(0.2,0.9,0.3,1.25)_120ms_both]" />
            </span>
            <div class="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                <p class="text-sm font-medium text-content">{{ title }}</p>
                <p v-if="landing.who" class="truncate text-xs text-content">{{ landing.who }}</p>
                <p class="text-xs text-muted">{{ where }}</p>
            </div>
            <Button tier="accent" size="small" :label="chatLabel ?? t(`connect.connect.startChatting`)" @click="emit(`chat`)" />
        </div>
        <p v-if="landing.tab" class="text-2xs text-muted">{{ t(`connect.landed.closeTab`, { destination: landing.tab }) }}</p>
    </div>
</template>
