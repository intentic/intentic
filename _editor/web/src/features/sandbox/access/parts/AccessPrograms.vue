<script setup lang="ts">
import { Await, type IconName, Row, RowGroup, SkeletonRows } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ControlTokensSection from "../ControlTokensSection.vue";
import LinkedSandboxesSection from "../LinkedSandboxesSection.vue";
import { useAccessInventory } from "../useAccessInventory";

// ACCESS ▸ PROGRAMS: what reaches this sandbox with nobody signing in. The credentials minted here (API tokens, links
// from the owner's other sandboxes) come first, since each is made and revoked on its own row; then the doors other pages
// manage, counted rather than managed, so the question "what else can get in?" has its whole answer in one place.
// A maintainer's, as the daemon refuses every read here below.

const t = useT();

// Other doors, counted, not managed here.
const { inventory, loaded } = useAccessInventory();

// Only doors in use are listed: a count of zero is a door nobody opened, so it says nothing here. A count the daemon
// could not read stays, since an unread door is not a closed one.
// "2 devices", "1 runner", or both: a kind nobody paired is left out of the sentence rather than counted as zero.
const pairedWhat = (devices: number, runners: number): string => {
    const devicesPart = t(`sandbox.sandboxAccess.pairedDevices`, { count: devices }, devices);
    const runnersPart = t(`sandbox.sandboxAccess.pairedRunners`, { count: runners }, runners);
    if (devices > 0 && runners > 0) {
        return t(`sandbox.sandboxAccess.pairedBoth`, { devices: devicesPart, runners: runnersPart });
    }
    return devices > 0 ? devicesPart : runnersPart;
};
const notReadable = (): string => t(`sandbox.sandboxAccess.notReadableRightNow`);
const doors = computed(() => {
    const { webhooks, gates, ciRepos, paired } = inventory.value;
    const rows: { key: string; icon: IconName; title: string; description: string }[] = [];
    if (webhooks !== 0) {
        rows.push({
            key: `webhooks`,
            icon: `bolt`,
            title: t(`sandbox.sandboxAccess.webhooks`),
            description: webhooks === undefined ? notReadable() : t(`sandbox.sandboxAccess.webhooksLine`, { count: webhooks }, webhooks),
        });
    }
    if (gates !== 0) {
        rows.push({
            key: `gates`,
            icon: `shield`,
            title: t(`sandbox.sandboxAccess.releaseGates`),
            description: gates === undefined ? notReadable() : t(`sandbox.sandboxAccess.gatesLine`, { count: gates }, gates),
        });
    }
    if (ciRepos?.total !== 0) {
        rows.push({
            key: `ci`,
            icon: `sitemap`,
            title: t(`sandbox.sandboxAccess.ciNotifications`),
            description:
                ciRepos === undefined
                    ? notReadable()
                    : t(`sandbox.sandboxAccess.ciLine`, { count: ciRepos.total, hooked: ciRepos.hooked }, ciRepos.total),
        });
    }
    if (paired === undefined || paired.devices + paired.runners > 0) {
        rows.push({
            key: `paired`,
            icon: `desktop`,
            title: t(`sandbox.sandboxAccess.pairedDevicesRunners`),
            description:
                paired === undefined ? notReadable() : t(`sandbox.sandboxAccess.pairedLine`, { what: pairedWhat(paired.devices, paired.runners) }),
        });
    }
    return rows;
});
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Program credentials, every sandbox token whoever minted it. -->
        <ControlTokensSection />

        <!-- The owner's other sandboxes that may hand this one tasks, each held to the terms written on its link. -->
        <LinkedSandboxesSection />

        <!-- Machine access other than sign-ins and tokens. The whole group stands in while it is read, drawn as it last
             looked in this sandbox: its rows sit straight in it. -->
        <Await :of="loaded" imprint="sandbox.access.other-ways-in">
            <RowGroup v-if="doors.length > 0" :label="t(`sandbox.sandboxAccess.otherWaysIn`)" equal-rows>
                <Row v-for="door in doors" :key="door.key" :icon="door.icon" :title="door.title" :description="door.description" />
            </RowGroup>
            <template #fallback>
                <RowGroup :label="t(`sandbox.sandboxAccess.otherWaysIn`)" equal-rows>
                    <div role="status" aria-busy="true"><SkeletonRows :rows="3" /></div>
                </RowGroup>
            </template>
        </Await>
    </div>
</template>
