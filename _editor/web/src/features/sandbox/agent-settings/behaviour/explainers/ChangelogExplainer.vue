<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Explainer from "./Explainer.vue";
import { ARROW, BOX, BOX_FADED, BOX_GOOD, LANE } from "../../../../../components/explainerAtoms";

const t = useT();
</script>

<template>
    <Explainer
        :label="t(`sandbox.explainers.changelog.label`)"
        :title="t(`sandbox.explainers.changelog.title`)"
        :experience="t(`sandbox.explainers.changelog.experience`)"
        :tokens="t(`sandbox.explainers.changelog.tokens`)"
    >
        <div class="flex flex-col gap-1">
            <span :class="LANE">{{ t(`sandbox.explainers.changelog.enabled`) }}</span>
            <div class="flex flex-wrap items-center gap-1">
                <span :class="BOX"><Icon name="save" />{{ t(`sandbox.explainers.changelog.commit`) }}</span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX_GOOD"><Icon name="book" />{{ t(`sandbox.explainers.changelog.withNote`) }}</span>
            </div>
        </div>
        <div class="flex flex-col gap-1">
            <span :class="LANE">{{ t(`sandbox.explainers.changelog.disabled`) }}</span>
            <div class="flex flex-wrap items-center gap-1">
                <span :class="BOX"><Icon name="save" />{{ t(`sandbox.explainers.changelog.commit`) }}</span>
                <Icon name="arrow-right" :class="ARROW" />
                <span :class="BOX_FADED"><Icon name="minus" />{{ t(`sandbox.explainers.changelog.withoutNote`) }}</span>
            </div>
        </div>
        <p class="m-0 text-2xs text-muted">{{ t(`sandbox.explainers.changelog.perRepo`) }}</p>
    </Explainer>
</template>
