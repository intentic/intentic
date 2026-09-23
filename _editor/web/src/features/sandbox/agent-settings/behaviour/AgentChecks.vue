<script setup lang="ts">
import type { RuleFirings } from "@intentic/api-contract";
import { Row, RowGroup, timeAgo } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { rpcQuery } from "../../client/rpcQuery";
import { useSandboxQuery } from "../../client/useSandboxQuery";
import { NAMED_RULES } from "../../environment/rules";
import { useRules } from "../../environment/useRules";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// The daemon's own reviews of a turn: what only it keeps a record of, never a command (those are a repository's own).

const t = useT();

const { settings, byId, upsert, setEnabled } = useRules();
const { patch } = useSandboxSettings();

const viewing = () => byId(NAMED_RULES.viewing);

// Its own read: a firing is not an edit, so it never rides the settings object.
const { query: firingsQuery } = useSandboxQuery(rpcQuery(`settings.firings`));
const firings = computed<RuleFirings>(() => firingsQuery.data.value ?? {});
// A review that never asked is either off or aimed at something that has not happened; both are worth reading.
const lookAsked = computed(() => {
    const at = firings.value[NAMED_RULES.viewing];
    return at === undefined ? t(`sandbox.agentChecks.neverAsked`) : t(`sandbox.agentChecks.lastAsked`, { ago: timeAgo(at, { days: true }) });
});

// Built-in: tracks which rendered surfaces a turn changed and whether a browser observed them afterward.
const setViewing = (on: boolean): void => {
    const existing = viewing();
    if (existing !== undefined) {
        setEnabled(existing.id, on);
        return;
    }
    upsert({
        id: NAMED_RULES.viewing,
        label: t(`sandbox.agentChecks.lookAtWhatChanged`),
        moment: `turn.ending`,
        action: { kind: `builtin`, name: `verify-ui-edits` },
        enabled: on,
    });
};
</script>

<template>
    <RowGroup :label="t(`sandbox.agentChecks.reviews`)">
        <!-- Prompts a browser check after a turn edits a rendered surface, since a suite can't see a clipped label or a misaligned border. -->
        <Row icon="eye" :title="t(`sandbox.agentChecks.lookAtWhatChanged`)" :description="t(`sandbox.agentChecks.promptAssistantToOpen`)">
            <template #meta>{{ lookAsked }}</template>
            <template #control>
                <ToggleSwitch :model-value="viewing()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setViewing" />
            </template>
        </Row>

        <!-- Breakage found after the work left its turn: a land that turns main red goes back to its conversation, and
             main's CI red on one failure gets a fix agent once pushes go quiet. -->
        <Row icon="wrench" :title="t(`sandbox.agentChecks.repairAfterLanding`)" :description="t(`sandbox.agentChecks.repairAfterLandingNote`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.autoRepair ?? true"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ autoRepair: value })"
                />
            </template>
        </Row>
    </RowGroup>
</template>
