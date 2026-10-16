<script setup lang="ts">
import type { CommandOs } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import RunCommand from "../../../components/RunCommand.vue";
import { daemonVersion, oldestSupportedDaemon } from "../../../client/sandbox/daemon/useDaemonVersion";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useServingSlug } from "../environment/servingSlug";
import SandboxUpdateCard from "../overview/version/SandboxUpdateCard.vue";
import { updateCommand } from "./updateCommand";
import GateCard from "./GateCard.vue";

// Shown in place of the sandbox's pages when its daemon is older than the oldest this app supports
// (OLDEST_SUPPORTED_DAEMON in the contract, read off the /events hello by useDaemonVersion). Without it every page
// would open and fail feature by feature, one error per missing part, none of which says that the whole sandbox is
// behind. Here there is one cause and one way out: the sandbox is older than this app, and updating it is the fix. The
// update is the Sandbox page's own card, drawn here since this gate stands in front of that page too; a sandbox
// installed by hand also gets the one-liner to run on its machine. Nothing to wait for: the next hello after the
// update clears it.

const t = useT();

const { active } = useSandbox();
const slug = useServingSlug();

const title = computed(() =>
    active.value?.name === undefined ? t(`sandbox.sandboxTooOld.title`) : t(`sandbox.sandboxTooOld.titleNamed`, { name: active.value.name }),
);
// The platform restarts a hosted sandbox onto its new image from the update card; there is no machine to run a command on.
const hosted = computed(() => active.value?.hosted !== undefined && active.value.hosted !== null);
const command = (os: CommandOs): string => updateCommand(slug.value, os);
</script>

<template>
    <GateCard icon="box" :title="title" data-too-old>
        <p class="text-sm text-muted">
            {{ t(`sandbox.sandboxTooOld.olderThanApp`, { version: daemonVersion ?? ``, oldest: oldestSupportedDaemon }) }}
        </p>
        <template #below>
            <div class="text-left"><SandboxUpdateCard /></div>
            <RunCommand v-if="!hosted" class="text-left" :command="command" :explanation="t(`sandbox.sandboxTooOld.manual`)" />
        </template>
    </GateCard>
</template>
