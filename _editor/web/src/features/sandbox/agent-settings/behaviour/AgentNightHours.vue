<script setup lang="ts">
import { ClockTimeSchema, nightByHandUntil, type NightHours, NightHoursSchema, type NightQuestions, nightLength } from "@intentic/sandbox-contract/schemas/night-hours";
import { asZone, localZone, UTC, zoneLabel } from "@intentic/sandbox-contract/time";
import { Button, Notice, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock } from "@intentic/ui/format";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// THE OWNER'S NIGHT (settings `nightHours`, contract schemas/night-hours.ts). Set on purpose and off until then: while it
// lasts and nobody is at the editor, an agent's own question no longer parks its turn until morning. The hours are read
// on the sandbox's clock, the Clock row beside this group, which is named here only when it is not the reader's own.
// What a question gets is one answer with two values, the chosen one's consequence said under it rather than hidden in
// a tooltip, since it is the part a reader has to believe before switching this on.

const t = useT();

const { settings, patch, refusal } = useSandboxSettings();

const night = computed((): NightHours => settings.value?.nightHours ?? NightHoursSchema.parse({}));
// The four fields travel as one object, so every row writes the whole of it back.
const patchNight = (change: Partial<NightHours>): void => patch({ nightHours: { ...night.value, ...change } });

const zone = computed(() => asZone(settings.value?.timezone) ?? UTC);

// A night begun by hand (the Agents board's moon), in force whatever the switch says: said here as its own row, so the
// switch above never reads as the whole story while one is running. Its times are instants, so on the reader's clock.
const now = useNow(true, 60_000);
const byHandUntil = computed(() => nightByHandUntil(night.value, zone.value, now.value));
const byHandLine = computed(() => (night.value.asleepSince === undefined ? `` : t(`sandbox.agentNightHours.byHandNote`, { since: formatClock(night.value.asleepSince) })));
const endByHand = (): void => {
    const { asleepSince: _ended, ...rest } = night.value;
    patch({ nightHours: rest });
};

// How long the night is, and on whose clock where that is not the reader's: "8 h a night, on Europe/Warsaw time".
const lengthLine = computed(() => {
    const minutes = nightLength(night.value);
    if (minutes === 0) {
        return t(`sandbox.agentNightHours.empty`);
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const length = rest === 0 ? t(`sandbox.agentNightHours.hoursOnly`, { hours }) : t(`sandbox.agentNightHours.hoursMinutes`, { hours, minutes: rest });
    const named = zoneLabel(zone.value, localZone());
    return named === undefined ? t(`sandbox.agentNightHours.length`, { length }) : t(`sandbox.agentNightHours.lengthOn`, { length, zone: named });
});

// A cleared or half-typed field writes nothing and shows the kept time again.
const setTime =
    (key: `from` | `to`) =>
    (event: Event): void => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) {
            return;
        }
        const time = ClockTimeSchema.safeParse(input.value);
        if (!time.success) {
            input.value = night.value[key];
            return;
        }
        patchNight({ [key]: time.data });
    };
const setFrom = setTime(`from`);
const setTo = setTime(`to`);

const QUESTION_OPTIONS = computed(() => [
    { label: t(`sandbox.agentNightHours.decide`), value: `decide` },
    { label: t(`sandbox.agentNightHours.defer`), value: `defer` },
]);
const questions = computed<NightQuestions>({
    get: () => night.value.questions,
    set: (value) => patchNight({ questions: value }),
});
// What the chosen answer does, under the choice; what night hours never answer is the group's own note below it.
const questionsNote = computed(() =>
    questions.value === `decide` ? t(`sandbox.agentNightHours.decideBrief`) : t(`sandbox.agentNightHours.deferBrief`),
);
</script>

<template>
    <RowGroup data-setting="agent-night-hours" :label="t(`sandbox.agentNightHours.group`)">
        <Row icon="moon" :title="t(`sandbox.agentNightHours.keep`)" :description="t(`sandbox.agentNightHours.keepNote`)">
            <template #control>
                <ToggleSwitch :model-value="night.on" :disabled="settings === undefined" @update:model-value="(on: boolean) => patchNight({ on })" />
            </template>
        </Row>
        <Row
            v-if="byHandUntil !== undefined"
            data-night-by-hand
            icon="moon-fill"
            :title="t(`sandbox.agentNightHours.byHand`, { time: formatClock(byHandUntil) })"
            :description="byHandLine"
        >
            <template #control>
                <Button size="small" tier="boring" @click="endByHand">{{ t(`sandbox.agentNightHours.endByHand`) }}</Button>
            </template>
        </Row>
        <template v-if="night.on">
            <Row icon="clock" :title="t(`sandbox.agentNightHours.hours`)" :description="lengthLine">
                <template #control>
                    <span class="flex items-center gap-1.5">
                        <input
                            type="time"
                            step="300"
                            :aria-label="t(`sandbox.agentNightHours.from`)"
                            class="ui-field-box ui-field-sm w-28"
                            :value="night.from"
                            :disabled="settings === undefined"
                            @change="setFrom"
                        />
                        <span class="text-muted" aria-hidden="true">–</span>
                        <input
                            type="time"
                            step="300"
                            :aria-label="t(`sandbox.agentNightHours.to`)"
                            class="ui-field-box ui-field-sm w-28"
                            :value="night.to"
                            :disabled="settings === undefined"
                            @change="setTo"
                        />
                    </span>
                </template>
            </Row>
            <Row icon="comments" :title="t(`sandbox.agentNightHours.questions`)" :description="questionsNote">
                <template #control>
                    <SegmentedControl
                        v-model="questions"
                        :options="QUESTION_OPTIONS"
                        size="xs"
                        :wrap="true"
                        :class="{ 'pointer-events-none opacity-60': settings === undefined }"
                    />
                </template>
            </Row>
            <!-- Its own line, never the tail of a description a narrow pane cuts off: what a sleeper must be able to trust. -->
            <RowNote>{{ t(`sandbox.agentNightHours.questionsNote`) }}</RowNote>
        </template>
        <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
    </RowGroup>
</template>
