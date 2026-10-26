<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { askRemoveSandbox } from "../../../models/sandbox/removeSandbox";

// THE WAY OUT OF A SANDBOX WHOSE SETTINGS CANNOT OPEN. Removing or leaving one lives at the foot of its Overview, but a
// gate stands where that page would be: a sandbox that never came up, one that refuses this account, one too old for
// this app. Those are the sandboxes most often given up on, so each such gate offers it too, quietly, at its foot, and
// it asks the shell's one dialog (models/sandbox/removeSandbox.ts), which needs nothing from the sandbox itself.

const t = useT();
const { active } = useSandbox();
const owner = computed(() => active.value?.role === `owner`);

const ask = (): void => {
    if (active.value !== undefined) {
        askRemoveSandbox(active.value);
    }
};
</script>

<template>
    <button v-if="active" type="button" :class="ui.textButton({ tone: `subtle` }, `self-center`)" @click="ask">
        <Icon :name="owner ? `trash` : `sign-out`" class="shrink-0" />{{
            owner ? t(`sandbox.removeAsk.removeThis`) : t(`sandbox.removeAsk.leaveThis`)
        }}
    </button>
</template>
