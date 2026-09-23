<script setup lang="ts">
import { Button, ui, Icon, Modal, RowGroup } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import RepoCheckRow from "../../sandbox/agent-settings/behaviour/RepoCheckRow.vue";
import { useRepoChecks } from "../../sandbox/environment/useRepoChecks";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* WHAT THIS REPOSITORY ASKS TO HAVE RUN, opened from its own row in the tree. */

const dir = defineModel<string | undefined>({ required: true });

const { repos, pending, adopt } = useRepoChecks();

const visible = computed({
    get: () => dir.value !== undefined,
    set: (open: boolean) => {
        if (!open) {
            dir.value = undefined;
        }
    },
});

const entry = computed(() => (repos.value ?? []).find((candidate) => candidate.repo === dir.value));

const EXAMPLE = `{
  "checks": [
    { "when": "turn", "run": "pnpm lint" },
    { "when": "land", "run": "pnpm test" }
  ]
}`;
</script>

<template>
    <Modal v-model:open="visible" size="md" :header="t(`workspace.directoryChecks.checksIn`, { dir: dir ?? `` })">
        <div class="flex flex-col gap-4">
            <template v-if="entry !== undefined">
                <!-- Explain the switch before the control because the row cannot explain itself. -->
                <p class="text-xs text-subtle">
                    {{ t(`workspace.directoryChecks.repositoryDeclaresIn`) }} <code class="ui-code">{{ entry.path }}</code
                    >{{ t(`workspace.directoryChecks.theyTravelSwitchingOn`) }}
                </p>
                <RowGroup>
                    <RepoCheckRow :entry="entry" :busy="pending === entry.repo" @switch="(on: boolean) => adopt(entry!.repo, on)" />
                </RowGroup>
            </template>

            <template v-else>
                <p class="text-sm text-muted">
                    {{ t(`workspace.directoryChecks.repositoryDoesntDeclareAny`) }}
                    <span class="font-mono text-content">{{ dir }}/.intentic/checks.json</span>
                    {{ t(`workspace.directoryChecks.appearHereTravelRepository`) }}
                </p>
                <pre class="overflow-x-auto rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-2xs text-content">{{ EXAMPLE }}</pre>
                <i18n-t keypath="workspace.directoryChecks.whenIsOneOf" tag="p" class="text-2xs text-subtle" scope="global">
                    <template #when><span class="font-mono">when</span></template>
                    <template #edit><span class="font-mono">edit</span></template>
                    <template #turn><span class="font-mono">turn</span></template>
                    <template #land><span class="font-mono">land</span></template>
                </i18n-t>
            </template>
        </div>

        <template #footer>
            <!-- Where the rest of the answer lives: the daemon's own reviews and every other repository's checks. -->
            <RouterLink to="/sandbox/agent?section=finishing" :class="ui.linkButton(`mr-auto gap-1 text-xs text-muted hover:text-content`)">
                {{ t(`workspace.directoryChecks.allChecksInSandbox`) }} <Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
            <Button :label="t(`ui.action.close`)" text size="small" @click="dir = undefined" />
        </template>
    </Modal>
</template>
