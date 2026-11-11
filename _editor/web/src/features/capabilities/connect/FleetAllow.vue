<!-- The Sandbox fleet card as one press (model/fleetAllow.ts): what Allow lets this sandbox do on the reader's account,
     said in a sentence, and the press that mints the token under their own session and saves it to the card. The
     owner's only: the token acts on the account of whoever mints it. -->
<script setup lang="ts">
import type { AddCapabilityInput } from "@intentic/capability-catalog";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { Button, type NoticeModel, RowGroup, RowNote } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { apiClient } from "../../../lib/useApi";
import { allowFleet, fleetTokenLabel } from "../model/fleetAllow";

const t = useT();

const { save, instance } = defineProps<{
    /** The card's save, the daemon's streamed add; throws on a refusal. */
    save: (input: AddCapabilityInput) => Promise<void>;
    /** The connection as it stands, once there is one. */
    instance?: CapabilitySummary | undefined;
}>();

const emit = defineEmits<{
    /** What went wrong, on the page's own notice, or null to clear it. */
    notice: [notice: NoticeModel | null];
}>();

const { user } = useAuth();
const { active } = useSandbox();
const { isOwner } = useRole();
const allowing = ref(false);

// A token the card minted (it carries the platform's id), a token pasted by hand, or one the platform no longer takes.
const minted = computed(() => instance?.config[`tokenId`] !== undefined);
const revoked = computed(() => instance?.status.state === `error`);
const label = computed(() => fleetTokenLabel(active.value?.name));

const allow = async (): Promise<void> => {
    if (allowing.value || !isOwner.value) {
        return;
    }
    allowing.value = true;
    emit(`notice`, null);
    try {
        await allowFleet(
            {
                mint: async (name) => await apiClient.token.create({ label: name, scope: `provision` }),
                revoke: async (tokenId) => {
                    await apiClient.token.revoke({ tokenId });
                },
                save,
            },
            // One per sandbox: the connection's own id, else the tile's.
            instance?.id ?? `fleet`,
            label.value,
        );
    } catch (error) {
        emit(`notice`, noticeFrom(error, t(`capabilities.fleetAllow.couldNotAllow`)));
    } finally {
        allowing.value = false;
    }
};
</script>

<template>
    <RowGroup :label="t(`capabilities.fleetAllow.title`)">
        <RowNote variant="block">
            <div class="flex flex-col gap-3">
                <p class="text-xs text-content">
                    {{ user?.email ? t(`capabilities.fleetAllow.allows`, { email: user.email }) : t(`capabilities.fleetAllow.allowsYours`) }}
                </p>
                <p class="text-2xs text-subtle">{{ t(`capabilities.fleetAllow.limits`) }}</p>
                <!-- Connected: where the token is, and how it ends. -->
                <p v-if="instance && !revoked" class="flex items-center gap-1.5 text-xs text-success">
                    <Icon name="check-circle" class="shrink-0" />
                    {{ minted ? t(`capabilities.fleetAllow.allowed`, { label }) : t(`capabilities.fleetAllow.pasted`) }}
                </p>
                <p v-else-if="!isOwner" class="text-xs text-muted">{{ t(`capabilities.fleetAllow.ownerOnly`) }}</p>
                <div v-else class="flex flex-wrap items-center gap-3">
                    <Button
                        tier="accent"
                        size="small"
                        :label="revoked ? t(`capabilities.fleetAllow.allowAgain`) : t(`capabilities.fleetAllow.allow`)"
                        :loading="allowing"
                        :disabled="allowing"
                        @click="allow"
                    >
                        <template #icon><Icon name="check" /></template>
                    </Button>
                    <span class="text-2xs text-subtle">{{ t(`capabilities.fleetAllow.listedAs`, { label }) }}</span>
                </div>
            </div>
        </RowNote>
    </RowGroup>
</template>
