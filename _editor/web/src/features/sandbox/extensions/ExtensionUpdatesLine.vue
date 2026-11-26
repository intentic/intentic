<!-- The sandbox's answer about extension updates, one quiet line over either list: whether extensions installed from a
     registry update by themselves (every one without an answer of its own follows it), how many updates still wait for
     a person, and when the registry was last read. Only a maintainer can flip it; everyone else reads it as words. -->
<script setup lang="ts">
import { Notice, timeAgo, ui, vAction, vTooltip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, useId } from "vue";
import { useSandboxScope } from "../../../client/sandbox/scope/useSandboxScope";
import { useExtensions } from "../../../models/extensions/useExtensions";
import { useOperation } from "../../../workbench/operations/operations";
import { useExtensionUpdates } from "./useExtensionUpdates";

const t = useT();

const { manage, checkedAt, checking } = defineProps<{
    /** Whether this reader may change it; below maintainer the line says where it stands, with no switch. */
    manage: boolean;
    /** When the registry was last compared; absent until the first check has run. */
    checkedAt: string | undefined;
    /** A check is under way, started from this line. */
    checking: boolean;
}>();
const emit = defineEmits<{
    /** Compare against the registry now. */
    check: [];
    /** The one update waiting: open its extension, whose page leads with the offer and why it waits. */
    open: [id: string];
    /** Several waiting: the published list shows each with its Update. */
    browse: [];
}>();

const { extensions, updateDefaults } = useExtensions();
const { setUpdateDefaults } = useExtensionUpdates();
const scope = useSandboxScope();
// An older daemon sends no defaults and has no route to set them: the line keeps only its counts there.
const served = computed(() => updateDefaults.value !== undefined && scope.supportsRoute(`extensions.setUpdateDefaults`));
const automatic = computed(() => updateDefaults.value?.updates === `auto`);

// A setting written in a moment, whose end is the switch itself; in the ledger so a refusal outlives a remount.
const steer = useOperation(`sandbox/extensions/update-defaults`);
const busy = steer.busy;
const notice = steer.failure;
const flip = (on: boolean): void => {
    void steer.run({
        what: t(`sandbox.sandboxExtensions.updateAutomatically`),
        failed: t(`sandbox.sandboxExtensions.couldntChangeAutomatic`),
        quiet: true,
        task: () => setUpdateDefaults(on ? `auto` : `notify`),
    });
};

// What the registry offers that is not running: under automatic, each is one that asks for more (or failed to take);
// otherwise every offer waits.
const waiting = computed(() => extensions.value.filter((extension) => extension.update !== undefined));
const openWaiting = (): void => {
    const [only, ...rest] = waiting.value;
    if (only !== undefined && rest.length === 0) {
        emit(`open`, only.id);
    } else {
        emit(`browse`);
    }
};
const id = useId();
</script>

<template>
    <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-2xs text-subtle">
            <div v-if="served" class="flex items-center gap-2">
                <template v-if="manage">
                    <ToggleSwitch
                        :input-id="id"
                        :model-value="automatic"
                        :disabled="busy"
                        class="ui-switch-sm shrink-0"
                        @update:model-value="flip"
                    />
                    <label
                        :for="id"
                        v-tooltip.top="{
                            title: t(`sandbox.sandboxExtensions.updatesItself`),
                            note: t(`sandbox.sandboxExtensions.newPowersWait`),
                        }"
                        class="cursor-pointer text-muted"
                        >{{ t(`sandbox.sandboxExtensions.updateAutomatically`) }}</label
                    >
                </template>
                <span v-else class="text-muted">
                    {{ t(`sandbox.sandboxExtensions.updateAutomatically`) }} ·
                    {{ automatic ? t(`sandbox.autoUpdate.on`) : t(`sandbox.autoUpdate.off`) }}
                </span>
            </div>
            <!-- A flex line rather than text: its presses are block-level, and would otherwise each take a line. -->
            <p v-if="manage" class="ml-auto flex flex-wrap items-center gap-x-1">
                <template v-if="waiting.length > 0">
                    <button type="button" :class="ui.textButton({ size: `xs` })" @click="openWaiting">
                        {{ t(`sandbox.sandboxExtensions.waitingForYou`, { count: waiting.length }, waiting.length) }}
                    </button>
                    ·
                </template>
                <template v-if="checkedAt !== undefined">
                    {{ t(`sandbox.sandboxExtensions.updatesChecked`) }} {{ timeAgo(Date.parse(checkedAt)) }} ·
                </template>
                <button type="button" :class="ui.textButton({ size: `xs` })" :disabled="checking" v-action="() => emit(`check`)">
                    {{ checking ? t(`sandbox.sandboxExtensions.checking`) : t(`sandbox.sandboxExtensions.checkNow`) }}
                </button>
            </p>
        </div>
        <Notice v-if="notice" :of="notice" size="sm" />
    </div>
</template>
