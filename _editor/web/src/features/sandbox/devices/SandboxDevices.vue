<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AddDeviceDialog from "./AddDeviceDialog.vue";
import CardlessKeys from "./health/CardlessKeys.vue";
import ContainerHealthCard from "./health/ContainerHealthCard.vue";
import SharedIdentities from "./health/SharedIdentities.vue";
import DeviceBoard from "./board/DeviceBoard.vue";
import DevicePage from "./DevicePage.vue";
import { boardRoute, DELETED_ANCHOR, deviceRoute, selectedKey } from "../../../models/sandbox/devices/deviceLinks";
import { machineRows, slugOfDaemonUrl, withSandboxNames } from "../../../models/sandbox/devices/deviceRows";
import { useDevices } from "../../../models/sandbox/devices/useDevices";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useSandboxVersion } from "../../../models/sandbox/useSandboxVersion";

// The Devices view's body: what is on the other end of this sandbox. Two screens, one URL — the
// board of every machine, and `?device=<key>` for one of them — so a machine is deep-linkable and the back
// button works, instead of the reader's place living in four sets of accordion state.

const route = useRoute();
const router = useRouter();
// `readAt` is the only clock this tab keeps: when the list landed, not the wall clock. Every machine is judged on
// what it said when we last heard from it, so a list restored from cache or left on screen cannot age into "gone
// quiet" by itself, and nothing here re-derives on a tick.
const { devices, cardlessHosts, sharedIdentities, readAt, loaded, refetch } = useDevices();
// Whether the list has been read: before then, "no device is paired" and "no such machine" are guesses.
const listed = computed(() => loaded.value.state === `ready`);

// Pairing opens from the board, and from the Workspace's "Open in local editor" shortcut, which lands here
// with the mint already asked for. Read before the redirects below, which rewrite the query out from under it.
const adding = ref(route.query[`enable`] === `desktop-sync`);

// The release this sandbox knows about, from the shared /info query (same value as its own update badge);
// undefined on a sandbox that hasn't reached the registry, or a dev build.
const { latest } = useSandboxVersion();

// The sandbox serving this page, by its container slug: the daemon's own hostname, same derivation the
// switcher and setup CLI use.
const { daemonUrl, sandboxes } = useSandbox();
const ownSlug = computed(() => slugOfDaemonUrl(daemonUrl.value));

// One row per PC: a Windows install and the WSL distros on it fold into one machine (machinesOf), so a two-door
// PC is one card and one page rather than two of each. Each container wears the name this account gave it.
const rows = computed(() => machineRows(withSandboxNames(devices.value, sandboxes.value), latest.value, readAt.value));

// The machine on screen is whatever the URL names, and nothing else: no derived fallback, or pressing
// "All devices" on a one-machine fleet would bounce straight back to it.
const selected = computed(() => {
    const key = selectedKey(route.query[`device`]);
    return key === undefined ? undefined : rows.value.find((row) => row.key === key);
});

// One machine means nothing to choose between, so the tab opens on it. Done as a redirect the first time
// the list settles rather than as a fallback, so the board stays reachable once asked for.
const chosen = ref(false);
watch(
    [rows, listed],
    ([known, read]) => {
        if (!read || chosen.value) {
            return;
        }
        chosen.value = true;
        const only = known.length === 1 ? known[0] : undefined;
        // Not for a reader who came for the deleted sandboxes (`#deleted`): those sit at the board's foot, and the
        // machine's page has no place for boxes that are no longer on it.
        if (only !== undefined && selectedKey(route.query[`device`]) === undefined && route.hash !== `#${DELETED_ANCHOR}`) {
            void router.replace(deviceRoute(only.key));
        }
    },
    { immediate: true },
);

// A `?device=` naming no machine we hold is cleaned back to the board, the same way the hub cleans an
// unknown tab slug. Immediate, since a dead link is dead on arrival and not only once something changes —
// but still gated on the read, or a perfectly good one would bounce before the list lands.
watch(
    [() => route.query[`device`], rows, listed],
    ([asked, known, read]) => {
        const key = selectedKey(asked);
        if (read && key !== undefined && !known.some((row) => row.key === key)) {
            void router.replace(boardRoute());
        }
    },
    { immediate: true },
);
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Setup faults qualify both device and sandbox screens. -->
        <ContainerHealthCard />

        <!-- Two live computers under one identity: above the machines, since the board below draws them as one. -->
        <SharedIdentities :identities="sharedIdentities" />

        <DevicePage
            v-if="selected"
            :key="selected.key"
            :machine="selected"
            :latest="latest"
            :own-slug="ownSlug"
            :read-at="readAt"
            :refetch="refetch"
        />
        <DeviceBoard v-else :rows="rows" :loaded="loaded" :own-slug="ownSlug" :read-at="readAt" @add="adding = true" />

        <!-- Connections no device card holds, left behind by a removed or renamed device: housekeeping, so under the
             machines rather than above them, and on both screens, since a one-machine fleet opens on its page. -->
        <CardlessKeys :keys="cardlessHosts" :machines="rows" :refetch="refetch" />

        <AddDeviceDialog v-model:open="adding" />
    </div>
</template>
