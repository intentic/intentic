<script setup lang="ts">
import { InfoDialog } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The (i) beside "Repository checks". */

const EXAMPLE = `{
  "checks": [
    { "when": "edit", "run": "pnpm lint {file}" },
    { "when": "push", "run": "pnpm verify:push" },
    { "when": "turn", "run": "pnpm verify:turn", "paths": ["src/**"] }
  ]
}`;
</script>

<template>
    <InfoDialog :title="t(`sandbox.repoChecksInfo.repositoryChecks`)">
        <p class="text-sm text-muted">
            {{ t(`sandbox.repoChecksInfo.repositorySayWhatShould`) }}
            <span class="font-mono text-content">.intentic/checks.json</span>{{ t(`sandbox.repoChecksInfo.travelsTeammateWhoClones`) }}
        </p>
        <pre class="mt-3 overflow-x-auto rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-2xs text-content">{{ EXAMPLE }}</pre>
        <!-- `when`, `edit`, `turn`, `push`, `{file}` and `cd` are the words the file itself uses, so they are slots the
             sentence moves around rather than words in it: a translated sentence still names the same keys. -->
        <i18n-t keypath="sandbox.repoChecksInfo.moments" tag="p" class="mt-2 text-2xs text-muted" scope="global">
            <template #when><span class="font-mono">when</span></template>
            <template #edit><span class="font-mono">edit</span></template>
            <template #file><span class="font-mono">{file}</span></template>
            <template #turn><span class="font-mono">turn</span></template>
            <template #push><span class="font-mono">push</span></template>
            <template #editAgain><span class="font-mono">edit</span></template>
            <template #there
                ><span class="font-medium text-content">{{ t(`sandbox.repoChecksInfo.inRepository`) }}</span></template
            >
            <template #cd><span class="font-mono">cd</span></template>
        </i18n-t>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.repoChecksInfo.whyToSwitchOn`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.repoChecksInfo.fileInRepositoryCommand`) }}
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.repoChecksInfo.whatStaysYours`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.repoChecksInfo.repositoryMaySayWhat`) }}
        </p>
    </InfoDialog>
</template>
