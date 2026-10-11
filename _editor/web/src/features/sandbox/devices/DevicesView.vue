<script setup lang="ts">
import { Page } from "@intentic/ui";
import { computed } from "vue";
import { useRoute } from "vue-router";
import SandboxDevices from "./SandboxDevices.vue";
import { selectedKey } from "./deviceLinks";

// The Devices view: what is on the other end of this sandbox, as a page of its own on the rail, the way This computer is
// one in a local window. Until 2026-10-01 it was a section of the Sandbox hub, which kept it a click and a list away and
// left the work running on a machine with nowhere outside the hub to show. The board and each machine's page are
// SandboxDevices; this only gives them the page every rail view stands in.

// The board is a grid of tiles and takes the wide page, so a fleet lays out three across where a window has the room;
// one machine's page is a column of rows and keeps the reading width.
const route = useRoute();
const width = computed(() => (selectedKey(route.query[`device`]) === undefined ? `wide` : `content`));
</script>

<template>
    <Page :width="width">
        <SandboxDevices />
    </Page>
</template>
