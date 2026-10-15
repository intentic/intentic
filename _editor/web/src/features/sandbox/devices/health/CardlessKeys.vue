<script setup lang="ts">
import type { CardlessHost } from "@intentic/sandbox-contract";
import { Button, Notice, type NoticeModel, Row, RowGroup } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRole } from "../../../../client/sandbox/useRole";
import { withdrawDeviceKey } from "../useDevices";

// (2026-10-15) Device keys no capability card holds: each still lets a computer knock on this sandbox, and no board draws
// a machine for it, since a machine is drawn from its card. The daemon refuses such a key at the door, but only the
// owner can say it should go, so it is listed here with the one button that withdraws it (DELETE /system/hosts/{id}) and
// never withdrawn by itself: the cards live in a workspace file a land can rewrite for a moment. Drawn only while there
// is one, and only for a reader who may withdraw it (maintainer and up, the daemon's own floor).

const props = defineProps<{
    keys: readonly CardlessHost[];
    /** Reads the list again once a key is gone, so the row leaves with it. */
    refetch: () => void;
}>();

const t = useT();
const { canShip } = useRole();

const withdrawing = ref<string | undefined>();
const failed = ref<string | undefined>();
const notice = computed<NoticeModel | undefined>(() =>
    failed.value === undefined ? undefined : { tone: `danger`, title: t(`sandbox.cardlessKeys.couldntWithdraw`), detail: failed.value },
);

// A distro's key names its card and the distro; the Windows side's is the card's own name.
const describe = (key: CardlessHost): string =>
    key.environment.startsWith(`wsl:`)
        ? t(`sandbox.cardlessKeys.distroOfCard`, { card: key.card, distro: key.environment.slice(`wsl:`.length) })
        : t(`sandbox.cardlessKeys.ofCard`, { card: key.card });

const withdraw = async (id: string): Promise<void> => {
    withdrawing.value = id;
    failed.value = undefined;
    try {
        await withdrawDeviceKey(id);
    } catch (error) {
        failed.value = messageOr(error, t(`sandbox.cardlessKeys.couldntWithdraw`));
    } finally {
        withdrawing.value = undefined;
        props.refetch();
    }
};
</script>

<template>
    <section v-if="canShip && keys.length > 0" class="flex flex-col gap-3">
        <Notice v-if="notice" :of="notice" />
        <RowGroup :label="t(`sandbox.cardlessKeys.title`)" :caption="t(`sandbox.cardlessKeys.caption`)">
            <Row v-for="key in keys" :key="key.id" icon="key" :description="describe(key)">
                <!-- Mono: the connection key, as the daemon's log and the hosts door name it. -->
                <template #title>
                    <span class="truncate font-mono">{{ key.id }}</span>
                </template>
                <template #control>
                    <Button
                        size="small"
                        tier="quiet"
                        tone="danger"
                        :label="t(`sandbox.cardlessKeys.withdraw`)"
                        :loading="withdrawing === key.id"
                        :disabled="withdrawing !== undefined"
                        @click="void withdraw(key.id)"
                    />
                </template>
            </Row>
        </RowGroup>
    </section>
</template>
