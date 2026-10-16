<script setup lang="ts">
import type { KeyringSource } from "@intentic/sandbox-contract/schemas/keyring";
import { CopyButton } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { keyringEditCommand, keyringModeWords, keyringStanding } from "./keyringWords";

// A secret kept in the keyring on one of the owner's computers, as its open row shows it: where it is, how it is shared
// with this sandbox, and the rules it goes by, which are the keyring's and are read here, never changed. The way to change
// them is a command on that computer, given whole so it can be copied there.

const t = useT();

const { row } = defineProps<{ row: SecretRow }>();

// Product names, the same in every language.
const SOURCES = {
    bitwarden: `Bitwarden`,
    "1password": `1Password`,
    keepassxc: `KeePassXC`,
} as const satisfies Readonly<Record<Exclude<KeyringSource, `keyring`>, string>>;

const device = computed(() => row.entry.device);
const machine = computed(() => device.value?.machine ?? ``);
const source = computed(() => (device.value === undefined || device.value.source === `keyring` ? undefined : SOURCES[device.value.source]));
const programs = computed(() => [...(row.entry.programs?.programs ?? []), ...(row.entry.programs?.packages ?? [])]);
const hosts = computed(() => row.entry.hosts?.list ?? []);
const command = computed(() => keyringEditCommand(row.entry.key));

// Sentences joined here rather than in the template, where a space between two of them is the formatter's to lose.
const standing = computed(() => {
    const now = device.value === undefined ? `` : t(`capabilities.secretDevice.standing`, { machine: machine.value, standing: keyringStanding(device.value) });
    return source.value === undefined ? now : `${now} ${t(`capabilities.secretDevice.readFrom`, { source: source.value })}`;
});
const rules = computed(() => {
    const where =
        programs.value.length > 0
            ? t(`capabilities.secretDevice.typedInto`, { programs: programs.value.join(`, `) })
            : t(`capabilities.secretDevice.everyTypingAsks`, { machine: machine.value });
    if (row.entry.programs?.anyField === true) {
        return `${where} ${t(`capabilities.secretDevice.anyField`)}`;
    }
    return programs.value.length > 0 ? `${where} ${t(`capabilities.secretDevice.passwordFieldOnly`)}` : where;
});
</script>

<template>
    <div v-if="device" class="mt-3 flex flex-col gap-1 border-t border-line pt-2" data-device-panel>
        <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`capabilities.secretDevice.heading`) }}</span>
        <p class="text-xs text-content">{{ t(`capabilities.secretDevice.keptOn`, { machine, mode: keyringModeWords(device.mode) }) }}</p>
        <p class="text-2xs text-muted">{{ standing }}</p>

        <!-- The keyring's own list: the sandbox can show it and never widen it. -->
        <p class="pt-1 text-2xs text-muted">{{ rules }}</p>
        <p v-if="hosts.length > 0" class="text-2xs text-muted">{{ t(`capabilities.secretDevice.hosts`, { hosts: hosts.join(`, `) }) }}</p>

        <p class="pt-1 text-2xs text-muted">{{ t(`capabilities.secretDevice.changeOn`, { machine }) }}</p>
        <div class="flex min-w-0 items-center gap-1.5">
            <code class="min-w-0 flex-1 truncate rounded-md border border-line bg-canvas px-2 py-1 font-mono text-2xs text-content">{{ command }}</code>
            <CopyButton :text="command" :aria-label="t(`capabilities.secretDevice.copyCommand`)" />
        </div>
    </div>
</template>
