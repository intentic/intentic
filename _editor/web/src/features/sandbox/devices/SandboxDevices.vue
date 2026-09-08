<script setup lang="ts">
import type { NoticeModel } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AddDeviceDialog from "./AddDeviceDialog.vue";
import ContainerHealthCard from "./ContainerHealthCard.vue";
import DeviceBoard from "./DeviceBoard.vue";
import DevicePage from "./DevicePage.vue";
import { boardRoute, deviceRoute, selectedKey } from "./deviceLinks";
import { deviceRows } from "./deviceRows";
import { useDevices } from "./useDevices";
import { useSandbox } from "../client/useSandbox";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useSandboxVersion } from "../overview/useSandboxVersion";

// The Sandbox hub's Devices tab: what is on the other end of this sandbox. Two screens, one URL — the
// board of every machine, and `?device=<key>` for one of them — so a machine is deep-linkable and the back
// button works, instead of the reader's place living in four sets of accordion state.

const route = useRoute();
const router = useRouter();
const { devices, error, isLoading, refetch } = useDevices();

// Pairing opens from the board, and from the Workspace's "Open in local editor" shortcut, which lands here
// with the mint already asked for. Read before the redirects below, which rewrite the query out from under it.
const adding = ref(route.query[`enable`] === `desktop-sync`);

// Before the list lands, "no device is paired" would be a guess; the outline holds the board's shape
// instead, for the first read only.
const outline = useSandboxOutline(isLoading);
// The list query's bare error, in the words of the screen that asked for it.
const notice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list your devices.`, detail: error.value },
);

// One quantised clock for the whole render: every derivation here hangs off it, and rounding to the poll
// interval (10s) stops the cascade from re-deriving every second for data that arrives every ten.
const CLOCK_STEP_MS = 10_000;
const ticking = useNow();
const now = computed(() => Math.floor(ticking.value / CLOCK_STEP_MS) * CLOCK_STEP_MS);

// The release this sandbox knows about, from the shared /info query (same value as its own update badge);
// undefined on a sandbox that hasn't reached the registry, or a dev build.
const { latest } = useSandboxVersion();

// The sandbox serving this page, by its container slug: the daemon's own hostname, same derivation the
// switcher and setup CLI use.
const { daemonUrl } = useSandbox();
const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));

const rows = computed(() => deviceRows(devices.value, latest.value, now.value));

// The machine on screen is whatever the URL names, and nothing else: no derived fallback, or pressing
// "All devices" on a one-machine fleet would bounce straight back to it.
const selected = computed(() => {
    const key = selectedKey(route.query[`device`]);
    return key === undefined ? undefined : rows.value.find((row) => row.device.key === key);
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
            void router.replace(deviceRoute(only.device.key));
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
        if (!reading && key !== undefined && !known.some((row) => row.device.key === key)) {
            void router.replace(boardRoute());
        }
    },
    { immediate: true },
);

</script>

<template>
    <div class="flex flex-col gap-4">
        <!--
            ABOVE BOTH SCREENS, because it is the one thing here that is not a state to read but a fault to act
            on: this sandbox was set up before something it now needs, and no verb below can give it back (each
            recreates the container out of what that container already carries). Draws nothing at all on a healthy
            sandbox, which is nearly all of them.
        -->
        <ContainerHealthCard />

        <DevicePage
            v-if="selected"
            :key="selected.device.key"
            :row="selected"
            :latest="latest"
            :own-slug="ownSlug"
            :now="now"
            :refetch="refetch"
        />
        <DeviceBoard
            v-else
            :rows="rows"
            :is-loading="isLoading"
            :notice="notice"
            :outline="outline"
            :own-slug="ownSlug"
            :now="now"
            @add="adding = true"
        />

        <AddDeviceDialog v-model:open="adding" />
    </div>
</template>
