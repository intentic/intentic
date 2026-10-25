<script setup lang="ts">
import { Icon, InfoHint, PersonaFace } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { ARROW, BOX, BOX_FADED, LANE } from "../../../components/explainerAtoms";

// The (i) beside "Your personas": what a persona is, drawn rather than told. Who wears one (a chat, an automation, the
// people granted the area it starts in) converges on one sample card holding the four things the editor below asks,
// under the same tab names, so the picture is a map of the form. Then what a turn gets with none, which is the reason
// to make one: a chat reaches every account, an automation nobody watches reaches none (personas.ts, turnPersona).
// Drawn with the Tools explainers' atoms, so every diagram card in the sandbox speaks one visual language.

const t = useT();

// A sample, labelled as one on the card. A writer, so the face wears the writer's prop (personaAccessory).
const sample = computed(() => ({ id: `writer`, label: t(`sandbox.sandboxPersonas.explainer.sampleName`) }));

const WEARERS = computed(
    () =>
        [
            { key: `chat`, icon: `comments`, label: t(`sandbox.sandboxPersonas.explainer.chat`) },
            { key: `automation`, icon: `automations`, label: t(`sandbox.sandboxPersonas.explainer.automation`) },
            { key: `area`, icon: `users`, label: t(`sandbox.sandboxPersonas.explainer.area`) },
        ] as const,
);

// Brand glyphs from the app's own set, not fetched logos: a hover card shouldn't tell a CDN who's looking.
const ACCOUNTS = [`discord`, `slack`, `github`, `envelope`] as const;
// Three switches, one off: a persona is as much what it may not do.
const SWITCHES = [true, true, false] as const;

// One facet tile's frame and its heading, shared by the four.
const TILE = `flex min-w-0 flex-col gap-1.5 rounded-md border border-line-subtle bg-canvas/60 p-1.5`;
const TILE_HEAD = `flex items-center gap-1 text-[0.625rem] font-medium leading-none text-subtle`;
// An account's glyph on a plate, the size a chip's mark is.
const GLYPH = `grid size-5 shrink-0 place-items-center rounded-md border border-line-subtle bg-card text-2xs text-muted`;
</script>

<template>
    <InfoHint :label="t(`sandbox.sandboxPersonas.explainer.label`)" wide>
        <div class="flex flex-col gap-3 text-xs">
            <p class="m-0 font-medium text-content">{{ t(`sandbox.sandboxPersonas.explainer.title`) }}</p>

            <figure class="m-0 flex flex-col gap-2 rounded-lg border border-line-subtle bg-canvas/60 p-3">
                <!-- Who wears it: three columns, so each box's centre is where its line leaves from. -->
                <span :class="LANE">{{ t(`sandbox.sandboxPersonas.explainer.wornBy`) }}</span>
                <div class="grid grid-cols-3 gap-1.5">
                    <span
                        v-for="wearer in WEARERS"
                        :key="wearer.key"
                        class="flex min-w-0 flex-col items-center gap-1 rounded-md border border-line bg-card px-1 py-1.5 text-center text-2xs leading-tight text-content"
                    >
                        <Icon :name="wearer.icon" class="text-subtle" />
                        {{ wearer.label }}
                    </span>
                </div>
                <!-- The three converge on the one card. Stretched to the column; the stroke keeps its width. -->
                <svg viewBox="0 0 300 18" preserveAspectRatio="none" class="-my-1 block h-4.5 w-full text-line-strong" aria-hidden="true">
                    <path d="M50 0 L150 18 M150 0 L150 18 M250 0 L150 18" fill="none" stroke="currentColor" vector-effect="non-scaling-stroke" />
                </svg>

                <!-- The persona itself: a card, its face on top, the editor's four questions inside. -->
                <div class="flex flex-col gap-2 rounded-lg border border-line bg-card p-2 shadow-sm">
                    <div class="flex flex-col items-center gap-0.5">
                        <PersonaFace :persona="sample" :size="32" />
                        <span class="text-xs font-medium text-content">{{ sample.label }}</span>
                    </div>
                    <div class="grid grid-cols-2 gap-1.5">
                        <div :class="TILE">
                            <span :class="TILE_HEAD"><Icon name="globe" />{{ t(`sandbox.personaForm.speaks`) }}</span>
                            <div class="flex flex-wrap gap-1">
                                <span v-for="glyph in ACCOUNTS" :key="glyph" :class="GLYPH"><Icon :name="glyph" /></span>
                            </div>
                        </div>
                        <div :class="TILE">
                            <span :class="TILE_HEAD"><Icon name="shield" />{{ t(`sandbox.personaForm.whatMayDo`) }}</span>
                            <div class="flex flex-wrap items-center gap-1">
                                <span
                                    v-for="(on, index) in SWITCHES"
                                    :key="index"
                                    class="flex h-2.5 w-4 shrink-0 items-center rounded-full p-px"
                                    :class="on ? `justify-end bg-primary-fill` : `bg-line-strong`"
                                    ><span class="size-2 rounded-full" :class="on ? `bg-fill-content` : `bg-card`"
                                /></span>
                                <!-- A folder name, which no language translates. -->
                                <span :class="BOX"><Icon name="folder" />docs/</span>
                            </div>
                        </div>
                        <div :class="TILE">
                            <span :class="TILE_HEAD"><Icon name="cpu" />{{ t(`sandbox.personaForm.runsOn`) }}</span>
                            <!-- Its models in the order they're tried; bars stand in for names. -->
                            <div class="flex flex-col gap-1 text-[0.625rem] leading-none text-subtle">
                                <span class="flex items-center gap-1">1<span class="h-1.5 w-16 rounded-full bg-muted/70" /></span>
                                <span class="flex items-center gap-1">2<span class="h-1.5 w-10 rounded-full bg-line-strong" /></span>
                            </div>
                        </div>
                        <div :class="TILE">
                            <span :class="TILE_HEAD"><Icon name="book" />{{ t(`sandbox.personaForm.whatTold`) }}</span>
                            <span class="line-clamp-2 text-[0.625rem] italic leading-snug text-muted">{{
                                t(`sandbox.sandboxPersonas.explainer.sampleBrief`)
                            }}</span>
                        </div>
                    </div>
                </div>

                <!-- With none, read off turnPersona: an attended chat reaches every account, an unattended automation none. -->
                <div class="mt-1 flex flex-col gap-1.5 border-t border-line-subtle pt-2">
                    <span :class="LANE">{{ t(`sandbox.sandboxPersonas.explainer.withoutOne`) }}</span>
                    <div class="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-1.5 gap-y-1">
                        <span :class="BOX"><Icon name="comments" />{{ t(`sandbox.sandboxPersonas.explainer.chat`) }}</span>
                        <Icon name="arrow-right" :class="ARROW" />
                        <span class="flex min-w-0 items-center gap-1 text-2xs text-muted">
                            <span v-for="glyph in ACCOUNTS" :key="glyph" :class="GLYPH"><Icon :name="glyph" /></span>
                            <span class="truncate">{{ t(`sandbox.sandboxPersonas.explainer.everyAccount`) }}</span>
                        </span>
                        <span :class="BOX"><Icon name="automations" />{{ t(`sandbox.sandboxPersonas.explainer.automation`) }}</span>
                        <Icon name="arrow-right" :class="ARROW" />
                        <span class="flex min-w-0 items-center gap-1 text-2xs text-muted">
                            <span :class="BOX_FADED"><Icon name="times" /></span>
                            <span class="truncate">{{ t(`sandbox.sandboxPersonas.explainer.noAccount`) }}</span>
                        </span>
                    </div>
                </div>
                <figcaption class="text-2xs text-subtle">{{ t(`sandbox.sandboxPersonas.explainer.sample`) }}</figcaption>
            </figure>
        </div>
    </InfoHint>
</template>
