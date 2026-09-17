<script setup lang="ts">
import { Code, useDevice } from "@intentic/ui";
import { computed } from "vue";
import type { ComposeArgs } from "./setupCompose";
import { composeBootstrap, composeFile } from "./setupCompose";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The "Docker Compose" tab of setup's Run step: the same sandbox + tunnel connect.sh starts. */

const props = defineProps<{ args: ComposeArgs }>();
// Forty-odd lines of YAML is a file to paste into an editor, not something anyone reads down a phone: on a
// phone it is clamped to a glimpse of what it declares, with the copy button (and "Show all") right there.
const { mobile } = useDevice();

const yaml = computed(() => composeFile(props.args));
const bootstrap = computed(() => composeBootstrap(props.args));
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- What this tab is actually FOR, said before the YAML rather than left to be inferred from it. -->
        <p class="flex items-start gap-2 text-xs text-muted">
            <Icon name="eye" class="mt-0.5 shrink-0 text-subtle" />
            <span class="min-w-0">{{ t(`setup.setupCompose.noScriptRunsOn`) }}</span>
        </p>
        <Code :code="yaml" lang="yaml" :label="t(`setup.setupCompose.n1AddServicesTo`)" :wrap="false" :clamp-lines="mobile ? 8 : undefined" />
        <Code :code="bootstrap" lang="bash" :label="t(`setup.setupCompose.n2InSameFolder`)" :wrap="true" />
        <p class="text-xs text-muted">
            {{ t(`setup.setupCompose.firstCommandRedeemsSetup`) }} <code>.env</code> {{ t(`setup.setupCompose.composeReadsRunOnce`) }}
            <code>docker compose</code> (<code>up -d</code>, <code>down</code>, <code>logs</code>{{ t(`setup.setupCompose.workspaceLivesInNamed`) }}
            <code>down</code>/<code>up</code> {{ t(`setup.setupCompose.keeps`) }}
        </p>
        <p class="text-xs text-muted">
            {{ t(`setup.setupCompose.desktopSyncIsntPart`) }} <b>{{ t(`setup.setupCompose.desktopSync`) }}</b> {{ t(`setup.setupCompose.card`) }}
        </p>
        <p v-if="args.platformUrl" class="flex items-start gap-2 text-xs text-warning">
            <Icon name="box" class="mt-0.5 shrink-0" />
            <!-- min-w-0 + break-words: the image reference is one unbreakable token wider than a phone, and a flex child defaults to min-content width. -->
            <span class="min-w-0 break-words"
                >{{ t(`setup.setupCompose.localDevComposePulls`) }} <b>{{ t(`setup.setupCompose.published`) }}</b> <code>{{ args.image }}</code>
                {{ t(`setup.setupCompose.notLocalCheckoutCompose`) }} <code>PLATFORM_URL</code> {{ t(`setup.setupCompose.pointsAtMachineRun`) }}</span
            >
        </p>
    </div>
</template>
