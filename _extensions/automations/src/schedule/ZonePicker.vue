<!-- Which clock a schedule's times are on: the sandbox's own (stored as nothing), the reader's, or any zone ICU knows, found by typing. -->
<script setup lang="ts">
import { localZone, sameClock, type Zone } from "@intentic/sandbox-contract/time";
import { Picker, type PickerGroup } from "@intentic/extension-ui";
import { computed } from "vue";
import { t } from "../i18n.js";

const props = defineProps<{
    /** The sandbox's own clock, which a blank override means. */
    sandboxZone: Zone;
}>();
// Blank is not "no zone", it is the sandbox's own, so moving that one setting moves every schedule that never asked for
// something else.
const tz = defineModel<string>({ required: true });

// Every zone ICU knows, which is the only list that cannot go stale against the runtime that will resolve it.
const ZONES = Intl.supportedValuesOf(`timeZone`);

// "GMT+2" beside each, so a zone is recognised by where its clock stands today, not only by its city.
const offsetOf = (zone: string): string =>
    // allow(format-tiers): a UTC offset is notation, the same in every language, and the kit has no formatter for one
    new Intl.DateTimeFormat(`en`, { timeZone: zone, timeZoneName: `shortOffset` })
        .formatToParts(Date.now())
        .find((part) => part.type === `timeZoneName`)?.value ?? ``;
const named = (zone: string): string => zone.replace(/_/g, ` `);

const options = computed<readonly PickerGroup[]>(() => {
    const reader = localZone();
    // The reader's own clock, offered by name only where it is not the sandbox's: two rows meaning one clock are noise.
    const yours = sameClock(reader, props.sandboxZone) ? [] : [{ value: reader, label: t(`zonePicker.yours`), description: named(reader) }];
    return [
        { options: [{ value: ``, label: t(`zonePicker.sandbox`), description: named(props.sandboxZone) }, ...yours] },
        { label: t(`zonePicker.every`), options: ZONES.map((zone) => ({ value: zone, label: named(zone), description: offsetOf(zone) })) },
    ];
});
</script>

<template>
    <Picker
        :model-value="tz"
        :options="options"
        :search-threshold="0"
        :aria-label="t(`automationFields.inZone`)"
        :header="t(`automationFields.inZone`)"
        class="w-60 max-w-full"
        @update:model-value="tz = $event ?? ``"
    />
</template>
