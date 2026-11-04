<!-- THE ONE OFFER TO LET A SANDBOX RUN ITSELF, made to someone it fits: a maintainer who reads plain words on a sandbox that
     still runs hands-on, at the moment it costs them something, finished work waiting for their press (ChatLandStrip.vue).
     Every sandbox from before the mode runs hands-on, and the people who answered "I don't write code" on one were the
     ones the plain words were for, so this asks them once whether the sandbox should accept, save and back up work by
     itself (settings `mode`). "Not now" puts it away on this device for this sandbox, for good; Settings ▸ Overview holds
     the same switch afterwards. -->
<script setup lang="ts">
import { Button, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useAudience } from "../../../../app/useAudience";
import { useRole } from "../../../../client/sandbox/useRole";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useSandboxMode } from "../../../../models/sandbox/mode/useSandboxMode";
import { offerDismissed, offersHandsOff } from "./handsOffOffer";

const t = useT();
const { canShip } = useRole();
const { mode, override, setAudience } = useAudience();
const { switchTo, saving } = useSandboxMode();
const sandbox = useSandbox();

const sandboxId = computed(() => sandbox.active.value?.id);
const shown = computed(() =>
    offersHandsOff({ canShip: canShip.value, mode: mode.value, override: override.value, sandboxId: sandboxId.value, dismissed: offerDismissed.value }),
);
const tip = computed((): Tip => ({ title: t(`chat.handsOffOffer.tipTitle`), note: t(`chat.handsOffOffer.tipNote`) }));

// The sandbox takes it over, and this person follows it again: their plain words were what hands-off speaks anyway.
const accept = async (): Promise<void> => {
    if (await switchTo(`hands-off`)) {
        setAudience(null);
    }
};
const notNow = (): void => {
    if (sandboxId.value !== undefined) {
        offerDismissed.value = [...offerDismissed.value, sandboxId.value];
    }
};
</script>

<template>
    <div v-if="shown" class="flex w-full flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-subtle pt-2" data-hands-off-offer>
        <span class="min-w-0 flex-1 text-muted">{{ t(`chat.handsOffOffer.line`) }}</span>
        <span class="flex shrink-0 items-center gap-1.5">
            <Button size="small" tier="quiet" :label="t(`chat.handsOffOffer.notNow`)" @click="notNow" />
            <Button v-tooltip.top="tip" size="small" tier="boring" :label="t(`chat.handsOffOffer.yes`)" :loading="saving" @click="accept" />
        </span>
    </div>
</template>
