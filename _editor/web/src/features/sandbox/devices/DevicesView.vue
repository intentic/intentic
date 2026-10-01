<script setup lang="ts">
import { Page } from "@intentic/ui";
import SandboxDevices from "./SandboxDevices.vue";

// The Devices view: what is on the other end of this sandbox, as a page of its own on the rail, the way This computer is
// one in a local window. Until 2026-10-01 it was a section of the Sandbox hub, which kept it a click and a list away and
// left the work running on a machine with nowhere outside the hub to show. The board and each machine's page are
// SandboxDevices; this only gives them the page every rail view stands in.
</script>

<template>
    <Page width="content">
        <SandboxDevices />
    </Page>
</template>
