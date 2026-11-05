<script setup lang="ts">
import type { PersonalDataClass } from "@intentic/sandbox-contract/schemas/privacy";
import type { PrivacyLeakCaught, PrivacyLeakState, PrivacyLeakView } from "@intentic/sandbox-contract/schemas/privacy-leaks";
import { Button, formatDate, formatDateTime, type IconName, Row, type TooltipValue } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { ledgerTime } from "./privacyShield";

// One leak: its value (its outline for a reader who may not read it), its kind, where it came from, and what finds a
// value like it now that its own exact copy is set aside, which is the question hardening answers. A suspected one is
// the owner's to confirm or dismiss; a confirmed one can still be called no personal data, which forgets its taught value.

const t = useT();

const { leak, revealed, kinds, busy } = defineProps<{
    leak: PrivacyLeakView;
    revealed: boolean;
    /** Each kind's short name, as the chip beside a value says it. */
    kinds: Readonly<Record<PersonalDataClass, string>>;
    busy: boolean;
}>();

const emit = defineEmits<{ judge: [state: `confirmed` | `dismissed`] }>();

const ICONS = { confirmed: `lock`, suspected: `question-circle`, dismissed: `eye` } as const satisfies Record<PrivacyLeakState, IconName>;

const shown = computed(() => (revealed && leak.value !== undefined ? leak.value : leak.outline));
// The text it stood in, behind the value, for a reader who may read it; the outline's key for one who may not.
const peek = computed((): TooltipValue => {
    if (!revealed || leak.value === undefined) {
        return t(`sandbox.agentPrivacyShield.leaks.outlineOnly`);
    }
    return leak.context === undefined || leak.context === `` ? undefined : { title: leak.value, note: leak.context };
});

// Why a scan suspects it is the daemon's own sentence, in English and usually naming the label said here already, so it
// is the line's tooltip rather than part of it.
const origin = computed(() => {
    const from = leak.origin === `reported` ? t(`sandbox.agentPrivacyShield.leaks.origin.reported`) : t(`sandbox.agentPrivacyShield.leaks.origin.suspected`);
    return leak.label === undefined ? from : `${from} · ${t(`sandbox.agentPrivacyShield.leaks.origin.label`, { label: leak.label })}`;
});

// A confirmed leak is masked as its exact value whatever else finds it; a suspected one is masked only if something does.
const CONFIRMED = computed(
    () =>
        ({
            no: t(`sandbox.agentPrivacyShield.leaks.caught.no`),
            rule: t(`sandbox.agentPrivacyShield.leaks.caught.rule`),
            detector: t(`sandbox.agentPrivacyShield.leaks.caught.detector`),
            model: t(`sandbox.agentPrivacyShield.leaks.caught.model`),
        }) satisfies Record<PrivacyLeakCaught, string>,
);
const SUSPECTED = computed(
    () =>
        ({
            no: t(`sandbox.agentPrivacyShield.leaks.suspectedCaught.no`),
            rule: t(`sandbox.agentPrivacyShield.leaks.suspectedCaught.rule`),
            detector: t(`sandbox.agentPrivacyShield.leaks.suspectedCaught.detector`),
            model: t(`sandbox.agentPrivacyShield.leaks.suspectedCaught.model`),
        }) satisfies Record<PrivacyLeakCaught, string>,
);
const standing = computed(() => {
    if (leak.state === `dismissed`) {
        return t(`sandbox.agentPrivacyShield.leaks.dismissedNote`);
    }
    return (leak.state === `confirmed` ? CONFIRMED : SUSPECTED).value[leak.caught];
});
// Said in warning only where a value still goes out as it is: a suspect nothing catches.
const standingTone = computed(() => (leak.state === `suspected` && leak.caught === `no` ? `text-warning` : `text-subtle`));

const time = computed(() => ledgerTime(leak.at));
</script>

<template>
    <Row :icon="ICONS[leak.state]">
        <template #title>
            <span class="flex min-w-0 items-baseline gap-1.5" :class="{ 'opacity-60': leak.state === `dismissed` }">
                <span v-tooltip.top="peek" class="truncate font-mono text-xs">{{ shown }}</span>
                <span class="shrink-0 rounded bg-content/5 px-1.5 py-0.5 text-3xs text-subtle">{{ kinds[leak.class] }}</span>
            </span>
        </template>
        <template #description
            ><span v-tooltip.top="leak.why">{{ origin }}</span></template
        >
        <template #meta>
            <span class="font-mono text-3xs text-subtle">{{ leak.id }}</span>
            <span v-if="time !== undefined" v-tooltip.top="formatDateTime(time)">{{ formatDate(time) }}</span>
        </template>
        <template #control>
            <Button v-if="leak.state !== `confirmed`" size="small" :tier="leak.state === `suspected` ? `boring` : `quiet`" :disabled="busy" @click="emit(`judge`, `confirmed`)">{{
                t(`sandbox.agentPrivacyShield.leaks.confirm`)
            }}</Button>
            <Button v-if="leak.state !== `dismissed`" size="small" tier="quiet" :disabled="busy" @click="emit(`judge`, `dismissed`)">{{
                t(`sandbox.agentPrivacyShield.leaks.dismiss`)
            }}</Button>
        </template>
        <template #below>
            <p class="text-2xs" :class="standingTone">{{ standing }}</p>
        </template>
    </Row>
</template>
