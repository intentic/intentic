<script setup lang="ts">
import type { SandboxKeyring } from "@intentic/sandbox-contract/schemas/secrets";
import { BrandMark, Button, Notice, type NoticeModel, Row, RowGroup, RowNote, StatusBadge, type StatusVariant, ui, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useKeyrings } from "../../capabilities/connect/secrets/useKeyrings";

// The keyrings on the owner's computers this sandbox reaches, one row each: whether it answers and is unlocked, how many
// of its entries are shared here, what waits for its next unlock, and whom it is paired with. Pairing two makes them
// keep one set of entries, sealed between them; each asks its person, showing both fingerprints, and only a yes on both
// pairs them. The fingerprints are said here too, so the person has something to compare each prompt with.

const t = useT();

const { keyrings, online, pair } = useKeyrings();

interface Standing {
    readonly label: string;
    readonly tone: StatusVariant;
}
const standingOf = (keyring: SandboxKeyring): Standing => {
    if (!keyring.online) {
        return { label: t(`sandbox.keyrings.offline`), tone: `neutral` };
    }
    return keyring.locked === true
        ? { label: t(`sandbox.keyrings.locked`), tone: `neutral` }
        : { label: t(`sandbox.keyrings.unlocked`), tone: `success` };
};

const factsOf = (keyring: SandboxKeyring): string =>
    [
        t(`sandbox.keyrings.shared`, { count: keyring.shared }),
        (keyring.pendingInbox ?? 0) > 0 ? t(`sandbox.keyrings.pendingInbox`, { count: keyring.pendingInbox ?? 0 }) : undefined,
        (keyring.sync?.peers.length ?? 0) > 0 ? t(`sandbox.keyrings.pairedWith`, { peers: keyring.sync?.peers.join(`, `) ?? `` }) : undefined,
    ]
        .filter((fact) => fact !== undefined)
        .join(` · `);

// Pairing needs two that answer now: each has to ask its own person.
const canPair = computed(() => online.value.length >= 2);
const pairing = ref(false);
const chosen = ref<string[]>([]);
const paired = ref<{ readonly a: string; readonly b: string; readonly fingerprints: { readonly a: string; readonly b: string } } | undefined>(
    undefined,
);
const pairError = ref<NoticeModel | undefined>(undefined);
const waiting = ref(false);

const openPair = (): void => {
    pairing.value = true;
    paired.value = undefined;
    pairError.value = undefined;
    chosen.value = online.value.slice(0, 2).map((keyring) => keyring.machine);
};
const closePair = (): void => {
    pairing.value = false;
    paired.value = undefined;
    pairError.value = undefined;
};

// Two at most: picking a third lets go of the one picked first.
const toggle = (machine: string): void => {
    if (chosen.value.includes(machine)) {
        chosen.value = chosen.value.filter((entry) => entry !== machine);
        return;
    }
    chosen.value = [...chosen.value, machine].slice(-2);
};

const fingerprintOf = (machine: string): string | undefined => keyrings.value.find((keyring) => keyring.machine === machine)?.sync?.fingerprint;
const fingerprintsKnown = computed(() => chosen.value.some((machine) => fingerprintOf(machine) !== undefined));

const doPair = async (): Promise<void> => {
    const [a, b] = chosen.value;
    if (a === undefined || b === undefined) {
        return;
    }
    pairError.value = undefined;
    paired.value = undefined;
    waiting.value = true;
    try {
        const answer = await pair.mutateAsync({ a, b });
        paired.value = { a, b, fingerprints: answer.fingerprints };
    } catch (err) {
        pairError.value = noticeFrom(err, t(`sandbox.keyrings.couldNotPair`));
    } finally {
        waiting.value = false;
    }
};
</script>

<template>
    <RowGroup data-setting="secrets-keyrings" :label="t(`sandbox.keyrings.title`)" :count="keyrings.length">
        <template #actions>
            <Button v-if="canPair && !pairing" size="small" tier="boring" :label="t(`sandbox.keyrings.pair`)" @click="openPair">
                <template #icon><Icon name="link" /></template>
            </Button>
        </template>

        <Row v-for="keyring of keyrings" :key="keyring.machine" :title="keyring.machine" :description="factsOf(keyring)">
            <template #lead="{ mark }"><BrandMark plain :size="mark" :name="keyring.machine" icon="desktop" /></template>
            <template #control><StatusBadge :variant="standingOf(keyring).tone" :label="standingOf(keyring).label" size="xs" /></template>
        </Row>

        <RowNote v-if="pairing" variant="block">
            <div class="flex flex-col gap-2">
                <p class="text-xs text-content">{{ t(`sandbox.keyrings.pairLead`) }}</p>
                <div class="flex flex-wrap gap-1" role="group" :aria-label="t(`sandbox.keyrings.pairWhich`)">
                    <button
                        v-for="keyring of online"
                        :key="keyring.machine"
                        type="button"
                        :class="ui.chip({ on: chosen.includes(keyring.machine) }, `gap-1 py-1 px-2 text-2xs`)"
                        :aria-pressed="chosen.includes(keyring.machine)"
                        :disabled="waiting"
                        @click="toggle(keyring.machine)"
                    >
                        <Icon name="desktop" class="text-2xs" />{{ keyring.machine }}
                    </button>
                </div>

                <!-- While both prompts are up: what each should show, so a yes is given to the right computer. -->
                <div v-if="waiting" class="flex flex-col gap-1" role="status">
                    <p class="text-xs text-content">{{ t(`sandbox.keyrings.confirmOnBoth`) }}</p>
                    <ul v-if="fingerprintsKnown" class="flex flex-col gap-0.5">
                        <li v-for="machine of chosen" :key="machine" class="text-2xs text-muted">
                            {{ machine }}: <span class="font-mono text-content">{{ fingerprintOf(machine) ?? `…` }}</span>
                        </li>
                    </ul>
                </div>

                <div v-else-if="paired" class="flex flex-col gap-1" role="status">
                    <p class="flex items-center gap-1.5 text-xs text-content">
                        <Icon name="check" class="text-success" />{{ t(`sandbox.keyrings.paired`, { a: paired.a, b: paired.b }) }}
                    </p>
                    <ul class="flex flex-col gap-0.5">
                        <li class="text-2xs text-muted">
                            {{ paired.a }}: <span class="font-mono text-content">{{ paired.fingerprints.a }}</span>
                        </li>
                        <li class="text-2xs text-muted">
                            {{ paired.b }}: <span class="font-mono text-content">{{ paired.fingerprints.b }}</span>
                        </li>
                    </ul>
                </div>

                <p v-if="paired || (waiting && fingerprintsKnown)" class="text-2xs text-subtle">{{ t(`sandbox.keyrings.compare`) }}</p>
                <Notice v-if="pairError" :of="pairError" />

                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <button
                        v-if="!paired"
                        type="button"
                        :class="ui.textButton({ size: `xs` })"
                        :disabled="chosen.length !== 2 || waiting"
                        v-action="doPair"
                    >
                        {{ t(`sandbox.keyrings.pairThese`) }}
                    </button>
                    <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="closePair">
                        {{ paired ? t(`ui.action.done`) : t(`ui.action.cancel`) }}
                    </button>
                </div>
            </div>
        </RowNote>
    </RowGroup>
</template>
