<!-- The computer's three switches for people's remote access, beside the buttons they gate: seeing the screen, using its
     mouse and keyboard, opening terminals. They are the computer's capability card's own settings (remoteView,
     remoteControl, remoteTerminal, off until switched on), so one flip here is that card saved with one setting changed,
     exactly as its form would save it. A maintainer flips them; anyone else reads them. -->
<script setup lang="ts">
import { Notice, Row } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { accessWords } from "../../../../client/sandbox/access/accessWords";
import { queryClient } from "../../../../lib/queryPersistence";
import { useCapabilities } from "../../../../models/capabilities/useCapabilities";
import { useOperation } from "../../../../workbench/operations/operations";
import { configWith, REMOTE_SWITCHES, type RemoteSwitch, switchedOn } from "./remoteSwitches";

const { card, editable } = defineProps<{
    card: CapabilitySummary;
    editable: boolean;
}>();

const t = useT();
const { add } = useCapabilities();
const save = useOperation(() => `devices/${card.id}/remote-switches`);
const maintainersOnly = computed(() => accessWords({ kind: `tier`, floor: `maintainer` }).short);

interface SwitchWords {
    readonly title: string;
    readonly note: string;
}
const words = (key: RemoteSwitch): SwitchWords => {
    switch (key) {
        case `remoteView`:
            return { title: t(`sandbox.deviceRemote.switchView`), note: t(`sandbox.deviceRemote.switchViewNote`) };
        case `remoteControl`:
            return { title: t(`sandbox.deviceRemote.switchControl`), note: t(`sandbox.deviceRemote.switchControlNote`) };
        default:
            return { title: t(`sandbox.deviceRemote.switchTerminal`), note: t(`sandbox.deviceRemote.switchTerminalNote`) };
    }
};

const flip = (key: RemoteSwitch, on: boolean): void => {
    void save.run({
        what: words(key).title,
        failed: t(`sandbox.deviceRemote.switchFailed`),
        quiet: true,
        task: async () => {
            await add({ id: card.id, kind: card.kind, config: configWith(card.config, key, on) });
            // What each environment can offer follows the switch at once, rather than at its next read.
            await queryClient.invalidateQueries({ predicate: (query) => JSON.stringify(query.queryKey).includes(`remote.status`) });
        },
    });
};
</script>

<template>
    <Row v-for="key in REMOTE_SWITCHES" :key="key" :title="words(key).title" :description="words(key).note">
        <template #control>
            <span v-if="!editable" v-tooltip.top="maintainersOnly" class="text-xs text-muted">{{
                switchedOn(card.config, key) ? t(`sandbox.deviceRemote.on`) : t(`sandbox.deviceRemote.off`)
            }}</span>
            <ToggleSwitch
                v-else
                :model-value="switchedOn(card.config, key)"
                :disabled="save.busy.value"
                :aria-label="words(key).title"
                @update:model-value="(on: boolean) => flip(key, on)"
            />
        </template>
    </Row>
    <Notice v-if="save.failure.value" :of="save.failure.value" />
</template>
