<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Explainer from "./Explainer.vue";
import { ARROW, BOX, BOX_GOOD, LANE } from "../../../../../components/explainerAtoms";

// Checks after edits, drawn: the loop inside a turn (edit, the repository's own check, what it found, the fix), then
// the one run as the turn ends, and the line that none of it ever holds a land, a commit or a push.

const t = useT();
</script>

<template>
    <Explainer
        :label="t(`sandbox.explainers.repoChecks.label`)"
        :title="t(`sandbox.explainers.repoChecks.title`)"
        :experience="t(`sandbox.explainers.repoChecks.experience`)"
        :tokens="t(`sandbox.explainers.repoChecks.tokens`)"
    >
        <div class="flex flex-col gap-1">
            <span :class="LANE">{{ t(`sandbox.explainers.repoChecks.eachEdit`) }}</span>
            <div class="flex flex-wrap items-center gap-1">
                <span :class="BOX"><Icon name="file-edit" />{{ t(`sandbox.explainers.repoChecks.edit`) }}</span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX"><Icon name="shield" /><code class="font-mono">eslint {file}</code></span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX"><Icon name="exclamation-circle" class="text-warning" />{{ t(`sandbox.explainers.repoChecks.findings`) }}</span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX_GOOD"><Icon name="check" />{{ t(`sandbox.explainers.repoChecks.fixed`) }}</span>
            </div>
        </div>
        <div class="flex flex-col gap-1">
            <span :class="LANE">{{ t(`sandbox.explainers.repoChecks.turnEnds`) }}</span>
            <div class="flex flex-wrap items-center gap-1">
                <span :class="BOX"><Icon name="list-check" />{{ t(`sandbox.explainers.repoChecks.endChecks`) }}</span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX">{{ t(`sandbox.explainers.repoChecks.saidBack`) }}</span>
            </div>
        </div>
        <p class="m-0 flex items-center gap-1.5 text-2xs text-muted">
            <Icon name="unlock" class="text-subtle" />{{ t(`sandbox.explainers.repoChecks.neverBlocks`) }}
        </p>
    </Explainer>
</template>
