<!-- THE NIGHT, FROM THE AGENTS BOARD (AgentsView.vue), in its header beside New agent: the last place someone looks before
     going to bed, and where they see in the morning what ran. Night hours (Sandbox ▸ Agent ▸ Finishing) come by
     themselves every evening; this is the press for the evening someone goes to bed before them, or keeps none.

     Quiet at rest: a bare moon, no box and no word, so a board with plenty on it gains one glyph. Lit while it is night
     (begun here or inside the hours): the moon fills and says when the morning is, on the reader's own clock, so the
     state reads at a glance without opening anything. Pressed, a small panel says what the night does before anyone
     starts one, since it decides things in the owner's name: begin it, end one begun here, or go to the hours. -->
<script setup lang="ts">
import { Button, Notice, ResponsiveOverlay } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock, formatElapsed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useAccess } from "../../../client/sandbox/access/useAccess";
import { here, page } from "../../../lib/routes/links";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import { settingHash } from "../../../workbench/hub/hubSearch";
import { beginNight, boardNight, endNight } from "./boardNight";

const t = useT();
const router = useRouter();
const { settings, patch, refusal } = useSandboxSettings();
const access = useAccess();
// Settings are written by Full access; until the reader's access is known the moon stands and the daemon decides.
const mayChange = computed(() => !access.known.value || access.can(`settings.set`));

// A minute is as fine as a morning needs, and the clock is shared with every other minute readout.
const now = useNow(true, 60_000);
const night = computed(() => (settings.value === undefined ? undefined : boardNight(settings.value, now.value)));
const lit = computed(() => night.value !== undefined && night.value.kind !== `day`);
const morning = computed(() => (night.value === undefined ? `` : formatClock(night.value.until)));
const span = computed(() => (night.value === undefined ? `` : formatElapsed((night.value.until - now.value) / 1000)));

const anchor = ref<HTMLElement>();
const open = ref(false);

const heading = computed(() => (lit.value ? t(`agents.boardNight.headingNight`, { time: morning.value }) : t(`agents.boardNight.headingDay`)));
const when = computed(() => {
    const shown = night.value;
    if (shown?.kind === `hand`) {
        return t(`agents.boardNight.whenHand`, { since: formatClock(shown.since), span: span.value });
    }
    return shown?.kind === `hours` ? t(`agents.boardNight.whenHours`, { span: span.value }) : t(`agents.boardNight.whenDay`, { time: morning.value, span: span.value });
});
// What a question gets, in the words of the answer the owner chose for their nights.
const effect = computed(() => (settings.value?.nightHours.questions === `defer` ? t(`agents.boardNight.defer`) : t(`agents.boardNight.decide`)));

const begin = (): void => {
    const hours = settings.value?.nightHours;
    if (hours !== undefined) {
        patch({ nightHours: beginNight(hours, Date.now()) });
        open.value = false;
    }
};
const end = (): void => {
    const hours = settings.value?.nightHours;
    if (hours !== undefined) {
        patch({ nightHours: endNight(hours) });
        open.value = false;
    }
};
const toHours = (): void => {
    open.value = false;
    void router.push(here(page.sandboxSettings(`agent`, { query: { section: `finishing` }, hash: settingHash(`agent-night-hours`) })));
};
</script>

<template>
    <template v-if="night !== undefined && mayChange">
        <!-- Sized and washed as the metrics line a stacked board keeps beside it (BoardMetrics.vue), so the header's quiet controls read as one set. -->
        <button
            ref="anchor"
            type="button"
            data-board-night
            :data-night="night.kind"
            :aria-expanded="open"
            aria-haspopup="dialog"
            :aria-label="lit ? heading : t(`agents.boardNight.begin`)"
            class="touch-target flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 transition-colors"
            :class="open ? `bg-content/8 text-content` : `text-muted hover:bg-content/5 hover:text-content`"
            v-tooltip.bottom="open || lit ? undefined : { title: t(`agents.boardNight.tipTitle`), note: t(`agents.boardNight.tipNote`) }"
            @click="open = !open"
        >
            <Icon :name="lit ? `moon-fill` : `moon`" class="text-xs" :class="lit ? `text-accent` : ``" />
            <span v-if="lit" class="text-2xs tabular-nums">{{ t(`agents.boardNight.until`, { time: morning }) }}</span>
        </button>
        <ResponsiveOverlay v-model="open" :anchor="anchor" side="bottom" cross="end" panel-class="w-72 max-w-[calc(100vw-2rem)]">
            <section data-panel="night" class="flex flex-col gap-2 p-3 text-xs" :aria-label="heading">
                <header class="flex flex-col gap-0.5">
                    <h3 class="font-medium text-content">{{ heading }}</h3>
                    <p class="text-subtle">{{ when }}</p>
                </header>
                <p class="text-muted">{{ effect }}</p>
                <p class="text-2xs text-subtle">{{ t(`agents.boardNight.stillAsks`) }}</p>
                <Notice v-if="refusal !== undefined" :of="refusal" />
                <div class="mt-1 flex items-center justify-between gap-2">
                    <Button size="small" tier="quiet" @click="toHours">{{ t(`agents.boardNight.hours`) }}</Button>
                    <Button v-if="night.kind === `day`" size="small" tier="accent" @click="begin">
                        <Icon name="moon" />{{ t(`agents.boardNight.goodNight`) }}
                    </Button>
                    <Button v-else-if="night.kind === `hand`" size="small" tier="boring" @click="end">{{ t(`agents.boardNight.end`) }}</Button>
                </div>
            </section>
        </ResponsiveOverlay>
    </template>
</template>
