<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock, formatTokens } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { turnInFlight } from "./agentStatus";
import { type CacheStanding, endedLine, keptWarm, refreshMinutes, warmChoices, warmOffer } from "./promptCache";
import { useAgents } from "./useAgents";

// Priced in refreshes before the press, since every refresh spends the account's own allowance.

const t = useT();

const props = defineProps<{ agent: CacheStanding & { readonly id: string } }>();
const emit = defineEmits<{ done: [] }>();

const { setKeepWarm } = useAgents();
const { settings } = useSandboxSettings();
const now = useNow(() => true);

const cache = computed(() => props.agent.promptCache);
const kept = computed(() => keptWarm(props.agent));
const ended = computed(() => props.agent.keepWarm?.ended);
const offered = computed(() => warmOffer(props.agent, now.value));
const choices = computed(() => (cache.value === undefined || !offered.value ? [] : warmChoices(cache.value, now.value)));
const tokens = computed(() => (props.agent.contextTokens === undefined ? t(`agents.keepWarm.everything`) : formatTokens(props.agent.contextTokens)));
const reserve = computed(() => 100 - (settings.value?.keepWarm.reserve ?? 15));

// What a hold does, priced in the unit the reader can check on the usage page: how often, and at what rate.
const explain = computed(() =>
    cache.value === undefined ? `` : t(`agents.keepWarm.explain`, { tokens: tokens.value, minutes: refreshMinutes(cache.value.ttlMs) }),
);

// Why nothing can be offered, most specific first; undefined when a hold can be armed or is already running.
const unavailable = computed((): string | undefined => {
    if (offered.value || kept.value !== undefined) {
        return undefined;
    }
    const current = cache.value;
    if (turnInFlight(props.agent)) {
        return t(`agents.keepWarm.turnRunning`);
    }
    if (current === undefined) {
        return t(`agents.keepWarm.noCache`);
    }
    if (current.keepableUntil === undefined) {
        return t(`agents.keepWarm.notKeepable`);
    }
    if (current.rollsAt !== undefined && current.rollsAt <= now.value) {
        return t(`agents.keepWarm.dateChanged`);
    }
    return t(`agents.keepWarm.alreadyCold`);
});

const busy = ref(false);
const refusal = ref<string>();
const choose = async (until: number | null): Promise<void> => {
    busy.value = true;
    refusal.value = undefined;
    try {
        await setKeepWarm(props.agent.id, until);
        emit(`done`);
    } catch (error) {
        // The daemon's own sentence: it names the one thing that stood in the way.
        refusal.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div class="flex max-w-80 flex-col gap-2 p-3 text-xs">
        <p class="font-medium text-content">
            {{ kept === undefined ? t(`agents.keepWarm.title`) : t(`agents.keepWarm.keptTitle`, { time: formatClock(kept.until) }) }}
        </p>
        <p v-if="kept !== undefined" class="text-subtle">
            {{
                kept.readTokens === undefined
                    ? t(`agents.keepWarm.noRefreshYet`)
                    : t(`agents.keepWarm.refreshedSoFar`, { refreshes: kept.refreshes, tokens: formatTokens(kept.readTokens) })
            }}
        </p>
        <p v-else-if="ended !== undefined && ended.reason !== `elapsed`" class="text-warning">{{ endedLine(ended) }}</p>
        <p v-if="explain !== `` && (offered || kept !== undefined)" class="text-subtle">{{ explain }}</p>
        <div v-if="choices.length > 0" class="flex flex-wrap gap-1.5">
            <Button v-for="choice in choices" :key="choice.until" size="small" severity="secondary" :disabled="busy" @click="choose(choice.until)">
                <span class="flex flex-col items-start text-left">
                    <span>{{ choice.capped ? t(`agents.keepWarm.untilTime`, { time: formatClock(choice.until) }) : t(`agents.keepWarm.hours`, { hours: choice.hours }) }}</span>
                    <span class="text-2xs text-subtle">{{ t(`agents.keepWarm.refreshes`, { refreshes: choice.refreshes }) }}</span>
                </span>
            </Button>
        </div>
        <p v-if="choices.some((choice) => choice.capped)" class="text-2xs text-subtle">{{ t(`agents.keepWarm.cappedNote`) }}</p>
        <p v-if="unavailable !== undefined" class="text-subtle">{{ unavailable }}</p>
        <p v-if="offered || kept !== undefined" class="text-2xs text-subtle">{{ t(`agents.keepWarm.stopsWhen`, { reserve }) }}</p>
        <div v-if="kept !== undefined">
            <Button size="small" severity="secondary" :disabled="busy" @click="choose(null)">{{ t(`agents.keepWarm.stop`) }}</Button>
        </div>
        <p v-if="refusal !== undefined" class="text-2xs text-warning">{{ refusal }}</p>
    </div>
</template>
