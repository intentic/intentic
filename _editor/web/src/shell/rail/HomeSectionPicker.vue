<!-- THE BOOKMARK: where a sandbox's sections go while the rail is unrolled onto every sandbox (MasterRail.vue), at its foot.
     The rail has room for one list at a time, so the sections its tiles were (Agents, the Workspace, every view behind
     More, Capabilities) fold into this one tile, and fly back out of it when the rail folds onto a sandbox
     (railMorph.ts, by `data-rail-holds`). It marks the view on screen, and picking another shows that view of the
     sandbox on screen and of every sandbox pressed after it, kept as what Home opens on (lib/routes/homeSection.ts).
     Muted at rest on the home conversation, lit while a section is shown, its hover naming which. -->
<script setup lang="ts">
import { ResponsiveOverlay, type Tip } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { chooseHomeSection, type HomeSection, homeSection, sameSection, sectionOfPage } from "../../lib/routes/homeSection";
import { frameOf, linkOf, pageOf } from "../../lib/routes/links";
import { homeEntryPath } from "../../models/sandbox/sandboxScreen";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import HomeSectionChoices from "./HomeSectionChoices.vue";

const t = useT();
const router = useRouter();
const route = useRoute();
const sandbox = useSandbox();

const open = ref(false);
const anchor = ref<HTMLElement>();
// The view on screen, as the section its page belongs to: a sandbox unrolled from, or pressed along the rail, shows a
// view nobody picked here. Around no page of a sandbox (Home's own chat, the account's pages), what Home opens on.
const chosen = computed((): Pick<HomeSection, `page`> | undefined => {
    const link = frameOf(route) === `home` && pageOf(route) !== undefined ? linkOf(route.fullPath) : undefined;
    const shown = link === undefined ? undefined : sectionOfPage(link);
    return shown === undefined ? homeSection.value : { page: shown };
});
// Its name: the picked section's as its tile said it, else the page's own title.
const chosenName = computed(() => {
    const picked = homeSection.value;
    return picked !== undefined && sameSection(picked, chosen.value) ? picked.label : (route.meta.title?.() ?? t(`home.section.view`));
});

const label = computed(() => (chosen.value === undefined ? t(`home.section.choose`) : t(`home.section.showing`, { name: chosenName.value })));
const tip = computed((): Tip =>
    chosen.value === undefined
        ? { title: t(`home.section.choose`), note: t(`home.section.forEverySandbox`) }
        : { title: t(`home.section.inEverySandbox`), rows: [{ label: t(`home.section.view`), value: chosenName.value }] },
);

// Chosen before the navigation, which opens what was chosen of the sandbox shown, in Home's frame; replaced rather than
// pushed, so Back never walks through views the reader has since left.
const choose = (section: HomeSection | undefined): void => {
    open.value = false;
    chooseHomeSection(section);
    const id = sandbox.activeSandboxId.value;
    void router.replace(id === undefined ? HOME_PATH : homeEntryPath(id));
};
</script>

<template>
    <button
        ref="anchor"
        type="button"
        class="icon-rail-tile ui-row-select ui-row-select-horizontal flex items-center justify-center rounded-lg"
        :class="[open ? `ui-row-select-on` : ``, chosen !== undefined || open ? `text-link` : `text-muted hover:text-content`]"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-pressed="chosen !== undefined"
        :aria-label="label"
        v-tooltip.right="open ? undefined : tip"
        data-home-section-picker
        data-rail-key="rail:sections"
        data-rail-holds="sections"
        @click="open = !open"
    >
        <Icon name="book" class="icon-rail-glyph" aria-hidden="true" />
    </button>
    <ResponsiveOverlay v-model="open" :anchor="anchor" side="right" cross="end" :header="t(`home.section.choose`)" panel-class="w-64 p-1">
        <HomeSectionChoices :chosen="chosen" @choose="choose" />
    </ResponsiveOverlay>
</template>
