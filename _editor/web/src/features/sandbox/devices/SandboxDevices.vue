<script setup lang="ts">
import type { NoticeModel } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AddDeviceDialog from "./AddDeviceDialog.vue";
import ContainerHealthCard from "./health/ContainerHealthCard.vue";
import DeviceBoard from "./DeviceBoard.vue";
import DevicePage from "./DevicePage.vue";
import { boardRoute, deviceRoute, selectedKey } from "./deviceLinks";
import { machineRows } from "./deviceRows";
import { useDevices } from "./useDevices";
import { useSandbox } from "../client/useSandbox";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useSandboxVersion } from "../overview/useSandboxVersion";
import { useT } from "@intentic/ui/i18n";

const t = useT();

// The Sandbox hub's Devices tab: what is on the other end of this sandbox. Two screens, one URL — the
// board of every machine, and `?device=<key>` for one of them — so a machine is deep-linkable and the back
// button works, instead of the reader's place living in four sets of accordion state.

const route = useRoute();
const router = useRouter();
// `readAt` is the only clock this tab keeps: when the list landed, not the wall clock. Every machine is judged on
// what it said when we last heard from it, so a list restored from cache or left on screen cannot age into "gone
// quiet" by itself, and nothing here re-derives on a tick.
const { devices, readAt, error, isLoading, refetch } = useDevices();

// Pairing opens from the board, and from the Workspace's "Open in local editor" shortcut, which lands here
// with the mint already asked for. Read before the redirects below, which rewrite the query out from under it.
const adding = ref(route.query[`enable`] === `desktop-sync`);

// Before the list lands, "no device is paired" would be a guess; the outline holds the board's shape
// instead, for the first read only.
const outline = useSandboxOutline(isLoading);
// The list query's bare error, in the words of the screen that asked for it.
const notice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: t(`sandbox.sandboxDevices.couldntListDevices`), detail: error.value },
);

// The release this sandbox knows about, from the shared /info query (same value as its own update badge);
// undefined on a sandbox that hasn't reached the registry, or a dev build.
const { latest } = useSandboxVersion();

// The sandbox serving this page, by its container slug: the daemon's own hostname, same derivation the
// switcher and setup CLI use.
const { daemonUrl } = useSandbox();
const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));

// One row per PC: a Windows install and the WSL distros on it fold into one machine (machinesOf), so a two-door
// PC is one card and one page rather than two of each.
const rows = computed(() => machineRows(devices.value, latest.value, readAt.value));

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
    [rows, isLoading],
    ([known, reading]) => {
        if (reading || chosen.value) {
            return;
        }
        chosen.value = true;
        const only = known.length === 1 ? known[0] : undefined;
        if (only !== undefined && selectedKey(route.query[`device`]) === undefined) {
            void router.replace(deviceRoute(only.key));
        }
    },
    { immediate: true },
);

// A `?device=` naming no machine we hold is cleaned back to the board, the same way the hub cleans an
// unknown tab slug. Immediate, since a dead link is dead on arrival and not only once something changes —
// but still gated on the read, or a perfectly good one would bounce before the list lands.
watch(
    [() => route.query[`device`], rows, isLoading],
    ([asked, known, reading]) => {
        const key = selectedKey(asked);
        if (!reading && key !== undefined && !known.some((row) => row.key === key)) {
            void router.replace(boardRoute());
        }
    },
    { immediate: true },
);
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- Setup faults qualify both device and sandbox screens. -->
        <ContainerHealthCard />

        <DevicePage
            v-if="selected"
            :key="selected.key"
            :machine="selected"
            :latest="latest"
            :own-slug="ownSlug"
            :read-at="readAt"
            :refetch="refetch"
        />
        <DeviceBoard
            v-else
            :rows="rows"
            :is-loading="isLoading"
            :notice="notice"
            :outline="outline"
            :own-slug="ownSlug"
            :read-at="readAt"
            @add="adding = true"
        />

        <AddDeviceDialog v-model:open="adding" />
    </div>
</template>
