<script setup lang="ts">
import { Icon, InfoHint, toneInk, toneTint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ARROW, BOX, BOX_FADED, LANE } from "../../../components/explainerAtoms";

// The (i) beside "Your areas": what an area is, drawn rather than told. One workspace's folders grouped into two named
// areas, one of them granted to a person, and what that person is left seeing; then the three things the grant carries,
// one line each. Sample folders and names, and the figure says so, since the rows on this page are the real ones.
// Drawn with the Tools explainers' boxes and arrows, so every (i) in the sandbox settings speaks one visual language.

const t = useT();

// Paths, not words: the same in every language.
const FRONTEND = [`web/`, `design/`];
const DOCS = [`docs/`];
const HIDDEN = [...DOCS, `billing/`];

/** An area: a named band around the folders it holds. */
const band = (tone: `primary` | `info`): string => toneTint(tone, `soft`, `flex flex-col items-start gap-1 rounded-lg border p-1.5`);
const BAND_NAME = `flex items-center gap-1 text-[0.625rem] font-medium leading-none`;
</script>

<template>
    <InfoHint :label="t(`sandbox.sandboxAreas.explainer.label`)" wide>
        <div class="flex flex-col gap-3 text-xs">
            <p class="m-0 font-medium text-content">{{ t(`sandbox.sandboxAreas.explainer.title`) }}</p>

            <!-- The diagram on a ground of its own, so its boxes read as one figure rather than as more of the card. -->
            <figure class="m-0 flex flex-col gap-2 rounded-lg border border-line-subtle bg-canvas/60 p-3">
                <div class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2">
                    <!-- The whole workspace: folders grouped into areas, and one folder no area holds. -->
                    <div class="flex min-w-0 flex-col gap-1.5">
                        <span :class="LANE">{{ t(`sandbox.sandboxAreas.explainer.workspace`) }}</span>
                        <div :class="band(`primary`)">
                            <span :class="[BAND_NAME, toneInk(`primary`)]">{{ t(`sandbox.sandboxAreas.explainer.frontend`) }}</span>
                            <span v-for="path in FRONTEND" :key="path" :class="BOX"><Icon name="folder" />{{ path }}</span>
                            <span :class="BOX"><Icon name="robot" />{{ t(`sandbox.sandboxAreas.explainer.assistant`) }}</span>
                        </div>
                        <div :class="band(`info`)">
                            <span :class="[BAND_NAME, toneInk(`info`)]">{{ t(`sandbox.sandboxAreas.explainer.docs`) }}</span>
                            <span v-for="path in DOCS" :key="path" :class="BOX"><Icon name="folder" />{{ path }}</span>
                        </div>
                        <span :class="BOX" class="self-start"><Icon name="folder" />billing/</span>
                    </div>

                    <!-- The grant: one area handed to one person, its key in that area's ink. -->
                    <div class="flex flex-col items-center justify-center gap-1 px-0.5 text-subtle">
                        <Icon name="key" :class="toneInk(`primary`, `text-xs`)" />
                        <span class="flex items-center">
                            <span class="h-px w-5 bg-line-strong" />
                            <Icon name="arrow-right" :class="ARROW" />
                        </span>
                        <span class="text-[0.625rem] leading-none">{{ t(`sandbox.sandboxAreas.explainer.grant`) }}</span>
                    </div>

                    <!-- What they are left with: the same band, and the rest of the tree gone from every view. -->
                    <div class="flex min-w-0 flex-col gap-1.5">
                        <span :class="LANE" class="flex items-center gap-1"><Icon name="user" />{{ t(`sandbox.sandboxAreas.explainer.personSees`) }}</span>
                        <div :class="band(`primary`)">
                            <span :class="[BAND_NAME, toneInk(`primary`)]">{{ t(`sandbox.sandboxAreas.explainer.frontend`) }}</span>
                            <span v-for="path in FRONTEND" :key="path" :class="BOX"><Icon name="folder" />{{ path }}</span>
                            <span :class="BOX"><Icon name="robot" />{{ t(`sandbox.sandboxAreas.explainer.assistant`) }}</span>
                        </div>
                        <span v-for="path in HIDDEN" :key="path" :class="BOX_FADED" class="self-start line-through decoration-line-strong">
                            <Icon name="eye-slash" />{{ path }}
                        </span>
                    </div>
                </div>
                <figcaption class="text-2xs text-subtle">{{ t(`sandbox.sandboxAreas.explainer.example`) }}</figcaption>
            </figure>

            <!-- What the grant carries, a glyph and a line each: what they see, who they reach, where their agents run. -->
            <dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1.5">
                <dt><Icon name="eye" class="text-subtle" /></dt>
                <dd class="m-0 text-muted">{{ t(`sandbox.sandboxAreas.explainer.sees`) }}</dd>
                <dt><Icon name="comments" class="text-subtle" /></dt>
                <dd class="m-0 text-muted">{{ t(`sandbox.sandboxAreas.explainer.talks`) }}</dd>
                <dt><Icon name="robot" class="text-subtle" /></dt>
                <dd class="m-0 text-muted">{{ t(`sandbox.sandboxAreas.explainer.agents`) }}</dd>
            </dl>
        </div>
    </InfoHint>
</template>
