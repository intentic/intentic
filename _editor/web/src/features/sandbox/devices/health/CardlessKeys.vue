<script setup lang="ts">
import type { CardlessHost } from "@intentic/sandbox-contract/schemas/devices";
import { Button, Notice, type NoticeModel, Row, RowGroup, RowNote } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRole } from "../../../../client/sandbox/useRole";
import type { MachineRow } from "../../../../models/sandbox/devices/deviceRows";
import { withdrawDeviceKey } from "../../../../models/sandbox/devices/useDevices";

// (2026-10-15) Device keys no capability card holds: each still lets a computer knock on this sandbox, and no board draws
// a machine for it, since a machine is drawn from its card. The daemon refuses such a key at the door, but only the
// owner can say it should go, so it is listed here with the one button that withdraws it (DELETE /system/hosts/{id}) and
// never withdrawn by itself: the cards live in a workspace file a land can rewrite for a moment. Drawn only while there
// is one, and only for a reader who may withdraw it (maintainer and up, the daemon's own floor).
// (2026-10-18) Said in the owner's words: a "leftover connection" a removed or renamed device left behind, under the
// board rather than above it, since it is housekeeping and not an alarm. The usual one is a card renamed to something
// other than its hostname: the old card was named after the computer, so a machine on the board whose hostname is that
// old name is the same computer, connected again, and the row says so.

const props = defineProps<{
    keys: readonly CardlessHost[];
    /** The machines on the board, to recognise the computer a leftover connection belongs to. */
    machines: readonly MachineRow[];
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

// The machine on the board this leftover is an earlier connection of: the one whose computer is called what the
// removed card was called. A hostname is not a join key across machines, but a card named after a computer is.
const ownerOf = (key: CardlessHost): MachineRow | undefined => {
    const name = key.card.toLowerCase();
    return props.machines.find((machine) =>
        machine.environments.some((environment) =>
            [environment.device.report?.hostname, environment.device.facts?.hostname].some((hostname) => hostname?.toLowerCase() === name),
        ),
    );
};

// A distro's connection names its card and the distro; the Windows side's is the card's own.
const describe = (key: CardlessHost): string => {
    const owner = ownerOf(key)?.label;
    const distro = key.environment.startsWith(`wsl:`) ? key.environment.slice(`wsl:`.length) : undefined;
    if (owner !== undefined) {
        return distro === undefined
            ? t(`sandbox.cardlessKeys.earlierOf`, { device: owner })
            : t(`sandbox.cardlessKeys.distroEarlierOf`, { device: owner, distro });
    }
    return distro === undefined ? t(`sandbox.cardlessKeys.ofGone`, { card: key.card }) : t(`sandbox.cardlessKeys.distroOfGone`, { card: key.card, distro });
};

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
        <RowGroup :label="t(`sandbox.cardlessKeys.title`)">
            <RowNote :label="t(`sandbox.cardlessKeys.caption`)" />
            <!-- Titled by the name the computer was connected under: the one the owner once typed, not the connection key. -->
            <Row v-for="key in keys" :key="key.id" icon="key" :title="key.card" :description="describe(key)">
                <template #control>
                    <Button
                        size="small"
                        tier="quiet"
                        tone="danger"
                        :label="t(`sandbox.cardlessKeys.remove`)"
                        :loading="withdrawing === key.id"
                        :disabled="withdrawing !== undefined"
                        @click="void withdraw(key.id)"
                    />
                </template>
            </Row>
        </RowGroup>
    </section>
</template>
