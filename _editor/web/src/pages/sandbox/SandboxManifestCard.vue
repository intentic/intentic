<script setup lang="ts">
import { DisclosureRow, RowGroup, StatusBadge } from "@intentic/ui";
import { computed, ref } from "vue";
import { useManifestProblems } from "../../composables/sandbox/useManifestProblems";
import { openWorkspaceRef } from "../../composables/workspace/openFileRef";
import { manifestNotices } from "./manifestNotice";

/* "Something in your settings files isn't being read": the companion to SandboxBehindCard.
 *
 * That card is about a mismatch between this app and the sandbox's build. This one is about the sandbox's own
 * state files: it read them, something in them didn't make sense, and it carried on with defaults. Both are
 * non-blocking notices about a thing that is quietly not working, which is why they sit together; they are
 * separate cards because the remedies have nothing in common: one is "update the sandbox", the other is
 * "there's a typo on line 12".
 *
 * A FILE IS A LINE. Not a paragraph, which is what this was: a three-sentence preamble explaining that settings
 * files exist and get read, a "1 to fix" badge counting a list that was right there, then the path, then a
 * sentence per problem running cause, hypothesis and two instructions together. For ONE misspelled key. Nobody
 * reads that; they see a block of amber text and scroll past, which is the worst outcome available to a notice.
 *
 * So a collapsed row is a NAME and a TAG — `settings.json` · `using defaults` — and that is the entire default
 * state of this card. Three broken files is three lines. The diagnosis and the instruction sit behind the row's
 * own chevron, where they cost nothing until somebody wants them, which is the right price for detail about a
 * config file that is, at worst, quietly using defaults.
 *
 *   • THE NAME, NOT THE PATH. All of these live in `.intentic/config/` (REPORTED_MANIFEST_PATHS), so the
 *     directory is chrome repeated down a column. The full path is the hover, and it is what a click opens.
 *   • THE TAG NAMES THE DAMAGE, never a count of complaints. "1 to fix" was too vague to act on and loud
 *     enough to alarm; "using defaults" is what decides whether this is opened now or after lunch.
 *   • THE FILE NAME OPENS THE FILE, because every one of these ends there and the app is an editor with the
 *     file in it. `hit="pair"` is what lets that click coexist with a row-wide press that opens the row. */

const { reports, hasProblems } = useManifestProblems();

const notices = computed(() => manifestNotices(reports.value));

// Which rows are open, keyed by path. Nothing is open on arrival: the card's job then is to say WHICH files and
// HOW BAD, and it does that in a line each.
const opened = ref<Record<string, boolean>>({});
const toggle = (path: string, open: boolean): void => {
    opened.value = { ...opened.value, [path]: open };
};
</script>

<template>
    <RowGroup v-if="hasProblems" label="Some settings aren't being applied">
        <DisclosureRow
            v-for="notice in notices"
            :key="notice.path"
            icon="exclamation-triangle"
            tone="warning"
            hit="pair"
            :open="opened[notice.path] === true"
            @update:open="toggle(notice.path, $event)"
        >
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        class="cursor-pointer rounded-sm text-left font-mono text-xs hover:text-link hover:underline"
                        :title="notice.path"
                        @click="void openWorkspaceRef(notice.path)"
                    >
                        {{ notice.file }}
                    </button>
                    <!-- Beside the name, not at the row's far edge: it is a fact ABOUT this file, and parked
                         against the right rail of a wide card it is a 700px eye-jump from the thing it
                         qualifies. -->
                    <StatusBadge variant="neutral" size="xs" :label="notice.impact" />
                </span>
            </template>
            <template #below>
                <div class="flex flex-col gap-1 pb-1 text-2xs">
                    <p v-for="(line, index) in notice.lines" :key="index" class="text-muted">{{ line }}</p>
                    <!-- The action outranks the diagnosis: the one line here anybody has to do anything with. -->
                    <p v-if="notice.fix !== undefined" class="text-content">{{ notice.fix }}</p>
                </div>
            </template>
        </DisclosureRow>
    </RowGroup>
</template>
