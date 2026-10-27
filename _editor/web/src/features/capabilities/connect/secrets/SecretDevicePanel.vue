<!-- A secret kept in the keyring on one of the owner's computers, as facts on its open row: where it is and how it is shared, or the rules it goes by there. Read here, never changed: the way to change them is a command on that computer. -->
<script setup lang="ts">
import { CopyButton } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { keyringEditCommand, keyringModeWords, keyringStanding } from "./keyringWords";
import { capitalized } from "./secretFacts";
import SecretFact from "./SecretFact.vue";
import { FIXED_VALUE, VALUE_NOTE, VALUE_TEXT } from "./secretLook";

const t = useT();

// `about` sits under the value (how it is shared, how to change it); `rules` beside the sandbox's own
// approver (what it may be typed into, where it may go), so a keyring's entry reads in the same two columns as any other.
const { row, part } = defineProps<{ row: SecretRow; part: `about` | `rules` }>();

const device = computed(() => row.entry.device);
const machine = computed(() => device.value?.machine ?? ``);
const programs = computed(() => [...(row.entry.programs?.programs ?? []), ...(row.entry.programs?.packages ?? [])]);
const hosts = computed(() => row.entry.hosts?.list ?? []);
const command = computed(() => keyringEditCommand(row.entry.key));

const typedNote = computed<string | undefined>(() => {
    if (programs.value.length === 0) {
        return undefined;
    }
    return row.entry.programs?.anyField === true ? t(`capabilities.secretDevice.anyField`) : t(`capabilities.secretDevice.passwordFieldOnly`);
});
</script>

<template>
    <template v-if="device && part === `about`">
        <SecretFact :label="t(`capabilities.secretDevice.sharedLabel`)" data-device-panel>
            <span :class="FIXED_VALUE">
                <span :class="VALUE_TEXT">{{ capitalized(keyringModeWords(device.mode)) }}</span>
                <span :class="VALUE_NOTE">{{ t(`capabilities.secretDevice.standing`, { machine, standing: keyringStanding(device) }) }}</span>
            </span>
        </SecretFact>
        <SecretFact :label="t(`capabilities.secretDevice.changeLabel`)">
            <span class="flex min-w-0 items-start gap-1.5 py-0.5">
                <code class="min-w-0 [overflow-wrap:anywhere] font-mono text-xs leading-5 text-content" data-keyring-command>{{ command }}</code>
                <CopyButton :text="command" :aria-label="t(`capabilities.secretDevice.copyCommand`)" />
            </span>
            <span :class="VALUE_NOTE">{{ t(`capabilities.secretDevice.changeOn`, { machine }) }}</span>
        </SecretFact>
    </template>

    <template v-else-if="device && part === `rules`">
        <SecretFact :label="t(`capabilities.secretPrograms.label`)">
            <span :class="FIXED_VALUE">
                <span :class="[VALUE_TEXT, programs.length > 0 ? `[overflow-wrap:anywhere] font-mono` : ``]">{{
                    programs.length > 0 ? programs.join(`, `) : t(`capabilities.secretDevice.asksOn`, { machine })
                }}</span>
                <span v-if="typedNote" :class="VALUE_NOTE">{{ typedNote }}</span>
            </span>
        </SecretFact>
        <SecretFact v-if="hosts.length > 0" :label="t(`capabilities.secretHosts.label`)">
            <span :class="FIXED_VALUE">
                <span :class="VALUE_TEXT" class="[overflow-wrap:anywhere] font-mono">{{ hosts.join(`, `) }}</span>
                <span :class="VALUE_NOTE">{{ t(`capabilities.secretHosts.elsewhereAsks`) }}</span>
            </span>
        </SecretFact>
    </template>
</template>
