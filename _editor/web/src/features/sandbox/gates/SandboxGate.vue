<script setup lang="ts">
import { FreshnessFrame } from "@intentic/ui";
import { computed, onUnmounted, watch } from "vue";
import { announceWorkspaceShown } from "../../../app/environments/desktopShown";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { sandboxRequiresGate } from "../overview/availability";
import { useSandboxAvailability } from "../overview/useSandboxAvailability";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useSandboxEstablished } from "./established";
import { daemonTooOld } from "../../../client/sandbox/daemon/useDaemonVersion";
import { useSandboxLiveness } from "../../../client/sandbox/freshness/queryFreshness";
import SandboxConnecting from "./SandboxConnecting.vue";
import SandboxTooOld from "./SandboxTooOld.vue";
import SandboxUnauthorized from "./SandboxUnauthorized.vue";
import SandboxWarming from "./SandboxWarming.vue";

// The sandbox-readiness gates shared by both shells: denied (403), too old for this app, warming, connecting. Once a
// sandbox has a cached snapshot, transient failures leave the live view mounted, and only exact unreachability gates
// it; the account-mismatch nudge and busy pill are conditions drawn in the notification lane instead.

const { reachable, connection } = useSandbox();
// A 403 (daemon refused this account) reads off the failure's tag rather than a separate sticky boolean.
const denied = computed(() => connection.value.failure?.kind === `forbidden`);
// A hydrated tree marks the sandbox as previously visited: painted stale-while-revalidate, not gated. So does a roster
// restored from the last visit, which is what a phone's board draws: without it the first screen waited on the whole
// connection before drawing a card, the tree being something that board never shows (established.ts).
const established = useSandboxEstablished();
const availability = useSandboxAvailability(established);
const gated = computed(() => sandboxRequiresGate(reachable.value, established.value, availability.value));
// What stays mounted through a stall is the last answers it had: the frame says when they may be out of date.
const { offline, lostAt } = useSandboxLiveness();

// The desktop app waits on this page, put up out of sight for a folder's new sandbox, to say it shows that sandbox
// before it calls the folder ready (desktop.ts `announceWorkspaceShown`): connected, its workspace painted, nothing
// gating it. Said a moment after it holds, so the routes under the gate have drawn too, and only if it still holds.
const SHOWN_AFTER_MS = 250;
const shownSandbox = computed(() =>
    !denied.value && !daemonTooOld.value && !gated.value && reachable.value && established.value ? activeSandboxId.value : undefined,
);
let saying: ReturnType<typeof setTimeout> | undefined;
watch(
    shownSandbox,
    (sandbox) => {
        clearTimeout(saying);
        if (sandbox !== undefined) {
            saying = setTimeout(() => {
                if (shownSandbox.value === sandbox) {
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
    <SandboxUnauthorized v-if="denied" />
    <!-- A daemon older than the oldest this app supports: one page that says so and offers the update, rather than every
         page failing on its own. Before warming, since its hello already named the version; established or not. -->
    <SandboxTooOld v-else-if="daemonTooOld" />
    <!-- A first connection with no workspace yet gates; an established one stays mounted with live actions disabled. -->
    <SandboxWarming v-else-if="gated && availability === `warming`" />
    <!-- A gate is for a workspace that never painted, or a cause waiting can't repair. -->
    <SandboxConnecting v-else-if="gated" />
    <FreshnessFrame v-else :offline="offline" :lost-at="lostAt"><slot /></FreshnessFrame>
</template>
