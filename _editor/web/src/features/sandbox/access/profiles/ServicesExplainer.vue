<script setup lang="ts">
import { Icon, InfoHint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, useId } from "vue";
import { BOX, LANE } from "../../../../components/explainerAtoms";

// The (i) beside "Services": what a service is, drawn rather than told. What starts work with nobody watching (an
// automation, a message, a linked sandbox, a control token) converges on one sample service holding the two things its
// row asks, its steward and its access profile; then what its runs reach, drawn as the overlap of the two, since a
// service is never more than its steward may (services.ts). Drawn with the Tools explainers' atoms, so every diagram
// card in the sandbox speaks one visual language.

const t = useT();

const STARTERS = computed(
    () =>
        [
            { key: `automation`, icon: `automations`, label: t(`sandbox.accessServices.explainer.automation`) },
            { key: `message`, icon: `envelope`, label: t(`sandbox.accessServices.explainer.message`) },
            { key: `linked`, icon: `sitemap`, label: t(`sandbox.accessServices.explainer.linked`) },
            { key: `token`, icon: `key`, label: t(`shared.apiTokens`) },
        ] as const,
);

// One facet tile's frame and its heading, as the Personas explainer draws them.
const TILE = `flex min-w-0 flex-col gap-1.5 rounded-md border border-line-subtle bg-canvas/60 p-1.5`;
const TILE_HEAD = `flex items-center gap-1 text-[0.625rem] font-medium leading-none text-subtle`;
// A legend swatch: the circle it names, drawn small.
const SWATCH = `size-3 shrink-0 rounded-full border`;

// The overlap is painted through a clip; two cards on one page must not share its id.
const clip = `services-reach-${useId()}`;
</script>

<template>
    <InfoHint :label="t(`sandbox.accessServices.explainer.label`)" wide>
        <div class="flex flex-col gap-3 text-xs">
            <p class="m-0 font-medium text-content">{{ t(`sandbox.accessServices.explainer.title`) }}</p>

            <figure class="m-0 flex flex-col gap-2 rounded-lg border border-line-subtle bg-canvas/60 p-3">
                <!-- What starts unattended work: four columns, so each box's centre is where its line leaves from. -->
                <span :class="LANE">{{ t(`sandbox.accessServices.explainer.startedBy`) }}</span>
                <div class="grid grid-cols-4 gap-1.5">
                    <span
                        v-for="starter in STARTERS"
                        :key="starter.key"
                        class="flex min-w-0 flex-col items-center gap-1 rounded-md border border-line bg-card px-1 py-1.5 text-center text-2xs leading-tight text-content"
                    >
                        <Icon :name="starter.icon" class="text-subtle" />
                        {{ starter.label }}
                    </span>
                </div>
                <!-- The four converge on the one service. Stretched to the column; the stroke keeps its width. -->
                <svg viewBox="0 0 400 18" preserveAspectRatio="none" class="-my-1 block h-4.5 w-full text-line-strong" aria-hidden="true">
                    <path
                        d="M50 0 L200 18 M150 0 L200 18 M250 0 L200 18 M350 0 L200 18"
                        fill="none"
                        stroke="currentColor"
                        vector-effect="non-scaling-stroke"
                    />
                </svg>

                <!-- The service itself: a card with its name, and the two things its row asks. -->
                <div class="flex flex-col gap-2 rounded-lg border border-line bg-card p-2 shadow-sm">
                    <div class="flex items-center justify-center gap-1.5">
                        <span class="grid size-6 place-items-center rounded-md bg-primary-tint text-primary"><Icon name="robot" /></span>
                        <span class="text-xs font-medium text-content">{{ t(`sandbox.accessServices.explainer.sampleName`) }}</span>
                    </div>
                    <div class="grid grid-cols-2 gap-1.5">
                        <div :class="TILE">
                            <span :class="TILE_HEAD"><Icon name="user" />{{ t(`sandbox.accessServices.steward`) }}</span>
                            <span class="text-[0.625rem] leading-snug text-muted">{{ t(`sandbox.accessServices.explainer.stewardIs`) }}</span>
                        </div>
                        <div :class="TILE">
                            <span :class="TILE_HEAD"><Icon name="shield" />{{ t(`sandbox.accessServices.explainer.profile`) }}</span>
                            <span class="text-[0.625rem] leading-snug text-muted">{{ t(`sandbox.accessServices.explainer.profileIs`) }}</span>
                        </div>
                    </div>
                </div>

                <!-- What its runs reach: the steward's reach and the profile, overlapping; the service is the overlap. -->
                <div class="mt-1 flex flex-col gap-1.5 border-t border-line-subtle pt-2">
                    <span :class="LANE">{{ t(`sandbox.accessServices.explainer.reaches`) }}</span>
                    <div class="flex items-center gap-3">
                        <svg viewBox="0 0 150 90" class="h-18 w-30 shrink-0 text-primary-fill" aria-hidden="true">
                            <defs>
                                <clipPath :id="`${clip}-steward`"><circle cx="55" cy="45" r="40" /></clipPath>
                                <clipPath :id="`${clip}-profile`"><circle cx="95" cy="45" r="40" /></clipPath>
                            </defs>
                            <!-- The steward's reach, solid; the profile, dashed. -->
                            <circle cx="55" cy="45" r="40" class="fill-card stroke-line-strong" stroke-width="1.5" />
                            <circle cx="95" cy="45" r="40" class="fill-none stroke-line-strong" stroke-width="1.5" stroke-dasharray="4 3" />
                            <!-- The overlap, filled and outlined: each circle painted through the other. -->
                            <circle cx="95" cy="45" r="40" :clip-path="`url(#${clip}-steward)`" fill="currentColor" fill-opacity="0.28" />
                            <circle cx="95" cy="45" r="40" :clip-path="`url(#${clip}-steward)`" fill="none" stroke="currentColor" stroke-width="1.5" />
                            <circle cx="55" cy="45" r="40" :clip-path="`url(#${clip}-profile)`" fill="none" stroke="currentColor" stroke-width="1.5" />
                        </svg>
                        <ul class="m-0 flex min-w-0 list-none flex-col gap-1.5 p-0 text-2xs leading-snug">
                            <li class="flex items-center gap-1.5 text-muted">
                                <span :class="SWATCH" class="border-line-strong bg-card" />{{ t(`sandbox.accessServices.explainer.stewardReach`) }}
                            </li>
                            <li class="flex items-center gap-1.5 text-muted">
                                <span :class="SWATCH" class="border-dashed border-line-strong" />{{ t(`sandbox.accessServices.explainer.profileReach`) }}
                            </li>
                            <li class="flex items-center gap-1.5 font-medium text-content">
                                <span :class="SWATCH" class="border-primary-fill bg-primary-fill/30" />{{ t(`sandbox.accessServices.explainer.serviceReach`) }}
                            </li>
                        </ul>
                    </div>
                </div>
                <figcaption class="text-2xs text-subtle">{{ t(`sandbox.accessServices.explainer.sample`) }}</figcaption>
            </figure>

            <dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1.5">
                <dt><Icon name="shield" class="text-subtle" /></dt>
                <dd class="m-0 text-muted">{{ t(`sandbox.accessServices.explainer.noProfile`) }}</dd>
                <dt><Icon name="sign-out" class="text-subtle" /></dt>
                <dd class="m-0 text-muted">{{ t(`sandbox.accessServices.explainer.stewardLeaves`) }}</dd>
            </dl>
        </div>
    </InfoHint>
</template>
