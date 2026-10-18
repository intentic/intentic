<script setup lang="ts">
import type { SharedIdentity } from "@intentic/sandbox-contract/schemas/devices";
import { Notice, type NoticeModel } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// (2026-10-18) Connections live at once that report one machine id: two computers sharing an identity, almost always
// because one was copied from the other. The daemon keeps both rather than dropping the older key (hosts/host-dedupe.ts),
// and the board joins machines on that id, so it draws them as one; this says why, and how the copy gets its own.
// A warning rather than a danger: nothing is broken yet, but the board is wrong about them until it is fixed.

const props = defineProps<{ identities: readonly SharedIdentity[] }>();

const t = useT();

// A connection by the name its card wears, and a distro's by its distro too: the names the board would have shown.
const named = ({ card, environment }: SharedIdentity[`connections`][number]): string =>
    environment.startsWith(`wsl:`) ? t(`sandbox.sharedIdentities.distroOf`, { card, distro: environment.slice(`wsl:`.length) }) : `"${card}"`;

const notices = computed<NoticeModel[]>(() =>
    props.identities.map((identity) => ({
        key: `${identity.machineId} ${identity.connections[0]?.environment ?? ``}`,
        tone: `warning`,
        title: t(`sandbox.sharedIdentities.title`),
        detail: t(`sandbox.sharedIdentities.detail`, {
            names: identity.connections.map(named).join(`, `),
        }),
    })),
);
</script>

<template>
    <section v-if="notices.length > 0" class="flex flex-col gap-3">
        <Notice v-for="notice in notices" :key="notice.key" :of="notice" />
    </section>
</template>
