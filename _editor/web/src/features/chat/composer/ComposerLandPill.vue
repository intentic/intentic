<!-- WHETHER THIS CHAT'S FINISHED WORK LANDS BY ITSELF, on the composer's row beside the Send it follows (ChatPane). Two
     shapes of one fact: an ordinary chat's own answer, a toggle whose press turns it back to the sandbox's
     (composerLanding.ts), and a home conversation's, which is nobody's to answer and so is said, never pressed: it
     lands and commits what it merged when a turn ends, or waits on its branch for a maintainer. Without the home's pill
     the row said nothing at all about where a home's work goes, so its person could not tell that it reached history. -->
<script setup lang="ts">
import { Icon, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { ComposerLanding } from "./composerLanding";

const t = useT();

const { landing, toggle, steered, flashed, plain } = defineProps<{
    landing: ComposerLanding;
    // The chat's own answer rides the row (composerMore.ts ridesRow), so its toggle is drawn.
    toggle: boolean;
    // A picked workflow has the composer: the toggle greys with the other setting pills.
    steered: boolean;
    // An `@` pick just changed the answer (composerPopovers.ts flashed).
    flashed: boolean;
    // Plain words: a maker's or a guest's, with no land and commit in them.
    plain: boolean;
}>();

const home = computed(() => landing.home.value);
const homeLabel = computed(() => {
    if (home.value === `asks`) {
        return t(`chat.composerLandPill.asksMaintainer`);
    }
    return plain ? t(`chat.composerLandPill.plain.savesItself`) : t(`chat.composerLandPill.landsCommits`);
});
// What happens at the end of a turn, as facts rather than a sentence in a hover box.
const homeHint = computed((): Tip => {
    const when = {
        label: t(`chat.composerLandPill.when`),
        value: plain ? t(`chat.composerLandPill.plain.replyEnds`) : t(`chat.composerLandPill.turnEnds`),
    };
    if (home.value === `asks`) {
        return {
            title: homeLabel.value,
            rows: [
                when,
                {
                    label: t(`chat.composerLandPill.work`),
                    value: plain ? t(`chat.composerLandPill.plain.waitsInDraft`) : t(`chat.composerLandPill.waitsOnBranch`),
                },
            ],
            note: plain ? t(`chat.composerLandPill.plain.maintainerAccepts`) : t(`chat.composerLandPill.maintainerLands`),
        };
    }
    return {
        title: homeLabel.value,
        rows: [
            when,
            plain
                ? { label: t(`chat.composerLandPill.plain.version`), value: t(`chat.composerLandPill.plain.namedFromWork`) }
                : { label: t(`chat.composerLandPill.commit`), value: t(`chat.composerLandPill.draftedSubject`) },
        ],
        note: plain ? t(`chat.composerLandPill.plain.nothingToAccept`) : t(`chat.composerLandPill.nobodyPressesLand`),
    };
});
const ownLabel = computed(() => (landing.lands.value ? t(`chat.chatPane.landsWhenDone`) : t(`chat.chatPane.holdsOnBranch`)));
</script>

<template>
    <!-- This chat's own answer to whether its finished work lands by itself; the press turns it back to the sandbox's. -->
    <button
        v-if="toggle"
        type="button"
        class="composer-ghost composer-glyph h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
        :class="{ 'composer-active': !steered, 'composer-steered': steered, 'composer-flash': flashed }"
        :disabled="steered"
        @click="landing.toggle()"
        v-tooltip.top="{
            title: ownLabel,
            note: landing.midTurn.value
                ? t(`chat.chatPane.appliesAfterTurn`)
                : landing.lands.value
                  ? t(`chat.chatPane.landsWhenDoneNote`)
                  : t(`chat.chatPane.holdsOnBranchNote`),
        }"
        :aria-pressed="landing.lands.value"
        :aria-label="ownLabel"
    >
        <Icon :name="landing.lands.value ? `download` : `pause`" class="text-2xs text-link" />
        <span class="@max-md:hidden">{{ ownLabel }}</span>
    </button>
    <!-- A home's: the pill's shape without its press (no wash, no pointer), focusable so a keyboard reaches its card. Not
         composer-ghost, whose hover is chat.css's and outranks a utility. -->
    <span
        v-else-if="home !== undefined"
        tabindex="0"
        class="composer-glyph inline-flex h-8 shrink-0 cursor-default items-center justify-center gap-1.5 rounded-lg px-2.5 text-2xs font-medium text-muted max-md:h-11"
        :aria-label="homeLabel"
        data-home-landing
        v-tooltip.top="homeHint"
    >
        <Icon :name="home === `lands` ? `download` : `pause`" class="text-2xs text-link" />
        <span class="@max-md:hidden">{{ homeLabel }}</span>
    </span>
</template>
