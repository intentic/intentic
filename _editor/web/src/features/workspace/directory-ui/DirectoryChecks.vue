<script setup lang="ts">
import { Button, ui, Icon, Modal, RowGroup } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import RepoCheckRow from "../../sandbox/agent-settings/behaviour/RepoCheckRow.vue";
import { useRepoChecks } from "../../sandbox/environment/useRepoChecks";

/* WHAT THIS REPOSITORY ASKS TO HAVE RUN, opened from its own row in the tree. The settings page lists every repository
 * at once, which answers "what runs when I push?"; this answers "what does THIS one do?", where the reader already is.
 * Same rows, same switch, one composable — the two surfaces cannot drift into describing the same file differently.
 *
 * A repository with no declaration gets the file it would need, not an apology: the path and the shape are the whole of
 * what somebody is missing, and both fit on the screen that told them it was empty. */

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
    { "when": "push", "run": "pnpm test" }
  ]
}`;
</script>

<template>
    <Modal v-model:open="visible" size="md" :header="`Checks in ${dir ?? ``}`">
        <div class="flex flex-col gap-4">
            <template v-if="entry !== undefined">
                <!-- What the switch means, before the switch: the same opening its sibling panel (DirectoryPersonas)
                     gives, and the one thing the row itself cannot say. -->
                <p class="text-xs text-subtle">
                    This repository declares these in <code class="ui-code">{{ entry.path }}</code
                    >, so they travel with it. Switching them on is what lets this sandbox run them.
                </p>
                <RowGroup>
                    <RepoCheckRow :entry="entry" :busy="pending === entry.repo" @switch="(on: boolean) => adopt(entry!.repo, on)" />
                </RowGroup>
            </template>

            <template v-else>
                <p class="text-sm text-muted">
                    This repository doesn't declare any checks of its own. Put a file at
                    <span class="font-mono text-content">{{ dir }}/.intentic/checks.json</span> and it will appear here, and travel with the
                    repository to anyone else who clones it.
                </p>
                <pre class="overflow-x-auto rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-2xs text-content">{{ EXAMPLE }}</pre>
                <p class="text-2xs text-subtle">
                    <span class="font-mono">when</span> is <span class="font-mono">push</span> or <span class="font-mono">turn</span>, and the command
                    runs in this folder, so write it as you would in a terminal here.
                </p>
            </template>
        </div>

        <template #footer>
            <!-- Where the rest of the answer lives: the sandbox-wide checks and every other repository's. -->
            <RouterLink to="/sandbox/agent?section=finishing" :class="ui.linkButton(`mr-auto gap-1 text-xs text-muted hover:text-content`)">
                All checks in this sandbox <Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
            <Button label="Close" text size="small" @click="dir = undefined" />
        </template>
    </Modal>
</template>
