<script setup lang="ts">
import { FreshnessFrame } from "@intentic/ui";
import { computed, onUnmounted, watch } from "vue";
import { useRoute } from "vue-router";
import { announceWorkspaceShown } from "../../../app/environments/desktopShown";
import { daemonTooOld } from "../../../client/sandbox/daemon/useDaemonVersion";
import { useSandboxLiveness } from "../../../client/sandbox/freshness/queryFreshness";
import { isAccountPath } from "../../../lib/routes/home";
import SandboxConnecting from "./SandboxConnecting.vue";
import SandboxTooOld from "./SandboxTooOld.vue";
import SandboxUnauthorized from "./SandboxUnauthorized.vue";
import SandboxWarming from "./SandboxWarming.vue";
import { useSandboxGateState } from "./workspaceShown";

// The sandbox-readiness gates shared by both shells: denied (403), too old for this app, warming, connecting. Once a
// sandbox has a cached snapshot, transient failures leave the live view mounted, and only exact unreachability gates
// it; the account-mismatch nudge and busy pill are conditions drawn in the notification lane instead.

const { denied, gated, availability, shown: shownSandbox } = useSandboxGateState();
// Both shells share this gate. Personal settings stay reachable while sandbox setup or recovery is unfinished.
const route = useRoute();
const accountPage = computed(() => isAccountPath(route.path));
const shownWorkspace = computed(() => accountPage.value ? undefined : shownSandbox.value);
// What stays mounted through a stall is the last answers it had: the frame says when they may be out of date.
const { offline, lostAt } = useSandboxLiveness();

// The desktop app waits on this page, put up out of sight for a folder's new sandbox, to say it shows that sandbox
// before it calls the folder ready (desktop.ts `announceWorkspaceShown`): connected, its workspace painted, nothing
// gating it. Said a moment after it holds, so the routes under the gate have drawn too, and only if it still holds.
const SHOWN_AFTER_MS = 250;
let saying: ReturnType<typeof setTimeout> | undefined;
watch(
    shownWorkspace,
    (sandbox) => {
        clearTimeout(saying);
        if (sandbox !== undefined) {
            saying = setTimeout(() => {
                if (shownWorkspace.value === sandbox) {
                    announceWorkspaceShown(sandbox);
                }
            }, SHOWN_AFTER_MS);
        }
    },
    { immediate: true },
);
onUnmounted(() => clearTimeout(saying));
</script>

<template>
    <slot v-if="accountPage" />
    <SandboxUnauthorized v-else-if="denied" />
    <!-- A daemon older than the oldest this app supports: one page that says so and offers the update, rather than every
         page failing on its own. Before warming, since its hello already named the version; established or not. -->
    <SandboxTooOld v-else-if="daemonTooOld" />
    <!-- A first connection with no workspace yet gates; an established one stays mounted with live actions disabled. -->
    <SandboxWarming v-else-if="gated && availability === `warming`" />
    <!-- A gate is for a workspace that never painted, or a cause waiting can't repair. -->
    <SandboxConnecting v-else-if="gated" />
    <FreshnessFrame v-else :offline="offline" :lost-at="lostAt"><slot /></FreshnessFrame>
</template>
