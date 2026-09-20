<script setup lang="ts">
import { localZone, sameClock, UTC, asZone } from "@intentic/sandbox-contract/time";
import { Row, RowGroup } from "@intentic/ui";
import { computed } from "vue";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// WHICH CLOCK THIS SANDBOX'S SCHEDULES ARE SET BY. Not a display preference: every time on screen is already drawn in
// the reader's own clock. This is the zone a cron's "09:00" MEANS, and the daemon runs in a UTC container, so without
// an answer here every schedule anybody types is read as UTC and fires at the wrong hour for most of the world.
// Usually set for you: the first browser to open the workspace offers its own zone (offerTimezone.ts), and this row is
// where that answer is visible and changeable.

const t = useT();

const { settings, patch } = useSandboxSettings();

const ZONE_OPTIONS = Intl.supportedValuesOf(`timeZone`);

// Empty is not a zone, it is an unanswered question, and the honest thing to show is the UTC that will actually be
// used rather than a blank that reads as "no opinion, therefore fine".
const effective = computed(() => asZone(settings.value?.timezone) ?? UTC);

// Worth saying out loud only when the two differ: an owner reading this on a machine in a different country is
// exactly the person who would otherwise assume the schedule follows the clock in front of them.
const readerDiffers = computed(() => !sameClock(effective.value, localZone()));

// Through `asZone` rather than straight from the select's value: the options come from ICU so one cannot be unknown,
// but a raw string is not a `Zone` and the type saying so is the whole point of the brand. An unresolvable value
// writes nothing instead of storing an id croner would throw on every tick.
const setZone = (event: Event): void => {
    const timezone = asZone((event.target as HTMLSelectElement).value);
    if (timezone !== undefined) {
        patch({ timezone });
    }
};
</script>

<template>
    <RowGroup :label="t(`sandbox.agentClock.clock`)">
        <Row
            icon="clock"
            :title="t(`sandbox.agentClock.scheduleTimesAreIn`)"
            :description="
                readerDiffers
                    ? t(`sandbox.agentClock.yourOwnClockIs`, { zone: localZone() })
                    : t(`sandbox.agentClock.whatAnAutomations`)
            "
        >
            <template #control>
                <select
                    class="ui-field-box ui-field-sm w-56"
                    :aria-label="t(`sandbox.agentClock.scheduleTimesAreIn`)"
                    :value="effective"
                    :disabled="settings === undefined"
                    @change="setZone"
                >
                    <option v-for="zone in ZONE_OPTIONS" :key="zone" :value="zone">{{ zone }}</option>
                </select>
            </template>
        </Row>
    </RowGroup>
</template>
