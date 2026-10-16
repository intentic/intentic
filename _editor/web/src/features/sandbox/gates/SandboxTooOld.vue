<script setup lang="ts">
import type { CommandOs } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import RunCommand from "../../../components/RunCommand.vue";
import { daemonVersion, oldestSupportedDaemon } from "../../../client/sandbox/daemon/useDaemonVersion";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useServingSlug } from "../../../models/sandbox/environment/servingSlug";
import { useHostRunning } from "../../../models/sandbox/devices/useDevices";
import SandboxUpdateCard from "../overview/version/SandboxUpdateCard.vue";
import { updateCommand } from "../../../models/sandbox/environment/updateCommand";
import GateCard from "./GateCard.vue";

// Shown in place of the sandbox's pages when its daemon is older than the oldest this app supports
// (OLDEST_SUPPORTED_DAEMON in the contract, read off the /events hello by useDaemonVersion). Without it every page
// would open and fail feature by feature, one error per missing part, none of which says that the whole sandbox is
// behind. Here there is one cause and one way out: the sandbox is older than this app, and updating it is the fix. The
// update is the Sandbox page's own card, drawn here since this gate stands in front of that page too; a sandbox
// installed by hand also gets the one-liner to run on its machine, folded away when this sandbox reaches that machine
// and the card's Update is the press. Nothing to wait for: the next hello after the update clears it.

const t = useT();

const { active } = useSandbox();
const slug = useServingSlug();

const title = computed(() =>
    active.value?.name === undefined ? t(`sandbox.sandboxTooOld.title`) : t(`sandbox.sandboxTooOld.titleNamed`, { name: active.value.name }),
);
// The platform restarts a hosted sandbox onto its new image from the update card; there is no machine to run a command on.
const hosted = computed(() => active.value?.hosted !== undefined && active.value.hosted !== null);
const command = (os: CommandOs): string => updateCommand(slug.value, os);
// The machine it runs on answers through this sandbox, by the rule the card's own Update button reads: the command is
// then only the way round a button that is right above it, kept for a card that has nothing to offer an old daemon.
const reachable = useHostRunning(() => slug.value);
</script>

<template>
    <GateCard icon="box" :title="title" data-too-old>
        <p class="text-sm text-muted">
            {{ t(`sandbox.sandboxTooOld.olderThanApp`, { version: daemonVersion ?? ``, oldest: oldestSupportedDaemon }) }}
        </p>
        <template #below>
            <div class="text-left"><SandboxUpdateCard /></div>
            <template v-if="!hosted">
                <details v-if="reachable" class="text-left text-xs">
                    <summary class="cursor-pointer text-link">{{ t(`sandbox.sandboxTooOld.byHand`) }}</summary>
                    <RunCommand class="mt-2" :command="command" />
                </details>
                <RunCommand v-else class="text-left" :command="command" :explanation="t(`sandbox.sandboxTooOld.manual`)" />
            </template>
        </template>
    </GateCard>
</template>
