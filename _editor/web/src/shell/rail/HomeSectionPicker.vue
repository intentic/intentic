<!-- WHAT HOME SHOWS OF EVERY SANDBOX, chosen at the foot of its rail (lib/routes/homeSection.ts): its home conversation, or
     one of a sandbox's own sections, the way Show a file picks one file to read in every folder
     (workspace/home/HomeCoverPicker.vue). A quiet tile by the account, since the rail is the one thing every view keeps:
     muted at rest, lit while a section is chosen, its hover naming which. -->
<script setup lang="ts">
import { ResponsiveOverlay, type Tip } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { chooseHomeSection, type HomeSection, homeSection } from "../../lib/routes/homeSection";
import { homeEntryPath } from "../../models/sandbox/sandboxScreen";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import HomeSectionChoices from "./HomeSectionChoices.vue";

const t = useT();
const router = useRouter();
const sandbox = useSandbox();

const open = ref(false);
const anchor = ref<HTMLElement>();
const chosen = computed(() => homeSection.value);

const label = computed(() => (chosen.value === undefined ? t(`home.section.choose`) : t(`home.section.showing`, { name: chosen.value.label })));
const tip = computed((): Tip =>
    chosen.value === undefined
        ? { title: t(`home.section.choose`), note: t(`home.section.forEverySandbox`) }
        : { title: t(`home.section.inEverySandbox`), rows: [{ label: t(`home.section.view`), value: chosen.value.label }] },
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
        @click="open = !open"
    >
        <Icon name="book" class="icon-rail-glyph" aria-hidden="true" />
    </button>
    <ResponsiveOverlay v-model="open" :anchor="anchor" side="right" cross="end" :header="t(`home.section.choose`)" panel-class="w-64 p-1">
        <HomeSectionChoices :chosen="chosen" @choose="choose" />
    </ResponsiveOverlay>
</template>
