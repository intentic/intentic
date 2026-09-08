<!--
    One document page: rendered prose, via the shared <Markdown> also used by chat and the file viewer, plus clickable workspace anchors and a
    staleness line. Draws no frame, scroller or padding of its own — each host (routed area, Workspace tab) decides how much room it gets.
-->
<script setup lang="ts">
import { appLink, ui, Icon, Markdown, StatusBadge, timeAgo } from "@intentic/extension-ui";
import { computed } from "vue";
import type { DocAnchor, DocIndexEntry, DocProvenance } from "./docModel.js";
import { host } from "./host.js";

const { prose, figures, anchors, provenance, repo, staleness } = defineProps<{
    prose: string | undefined;
    // Computed figures, as markdown, rendered in their own `<Markdown>` instance above the authored prose.
    figures?: string;
    anchors: readonly DocAnchor[];
    // Repo overview's provenance; a package page has none, its date is the index's last-touch commit instead.
    provenance?: DocProvenance;
    // Repo the anchors resolve against: document paths are repo-relative, the workspace route is root-relative.
    repo: string;
    // This page's row in the generated index, if any: the tool's verdict on whether it is still accurate.
    staleness: DocIndexEntry | undefined;
}>();

// Opens an anchor's file in the workspace view under its repo prefix. `line` is dropped: the workspace route only
// understands a path, not a line within it.
const anchorLink = (anchor: DocAnchor) => {
    const path = `/workspace/${repo === `` ? `` : `${repo}/`}${anchor.path}`;
    return appLink(host().href(path), () => host().navigate(path));
};

// writtenAt and rev come from provenance when present, else from the index's record of the README's last-touch commit.
const writtenAt = computed((): number => provenance?.generatedAt ?? staleness?.updatedAt ?? 0);
const rev = computed((): string => provenance?.sourceRev ?? staleness?.readmeRev ?? ``);
</script>

<template>
    <!-- Keyed per page by the caller: the fade is one page arriving, not a list animating. -->
    <article class="flex flex-col gap-5">
        <!--
            Staleness renders above the prose, naming the specific reason rather than just the verdict. Plain text, not a bordered panel; the dot
            matches the sidebar's amber marks.
        -->
        <p v-if="staleness?.stale === true" class="flex items-center gap-2 text-xs text-muted">
            <span class="size-1.5 shrink-0 rounded-full bg-warning/70" aria-hidden="true"></span>
            May be out of date: {{ staleness.reason }}.
        </p>

        <!-- Figures come from `intentic-docs check`'s computed index, not authored by hand. -->
        <Markdown v-if="figures !== undefined && figures !== ``" :source="figures" style="--prose-measure: 76ch" />

        <Markdown v-if="prose !== undefined" :source="prose" style="--prose-measure: 76ch" />
        <p v-else class="text-sm text-muted">This page has no prose yet.</p>

        <section v-if="anchors.length > 0" class="flex flex-col gap-0.5">
            <h2 :class="ui.sectionLabel(`mb-1 text-2xs`)">Where to start reading</h2>
            <!-- A real `<a>`, so hover, copy-address and Ctrl/Cmd-click-to-new-tab work natively. -->
            <a
                v-for="anchor in anchors"
                :key="anchor.path"
                v-bind="anchorLink(anchor)"
                class="ui-row-select flex w-full items-start gap-3 rounded-lg px-2.5 py-1.5 text-left"
            >
                <Icon name="file" class="mt-0.5 shrink-0 text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate font-mono text-xs text-link"
                        >{{ anchor.path }}<span v-if="anchor.line !== undefined">:{{ anchor.line }}</span></span
                    >
                    <span class="text-2xs text-muted">{{ anchor.what }}</span>
                </span>
            </a>
        </section>

        <footer v-if="writtenAt > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-2xs text-subtle">
            <StatusBadge :variant="staleness?.stale === true ? `warning` : `neutral`" size="xs" dot :label="`written ${timeAgo(writtenAt)}`" />
            <span v-if="rev !== ``"
                >{{ provenance === undefined ? `in` : `against` }} <span class="font-mono">{{ rev.slice(0, 8) }}</span></span
            >
            <span v-if="provenance?.model !== undefined">by {{ provenance.model }}</span>
            <span v-if="staleness !== undefined && staleness.behind > 0"
                >· {{ staleness.behind }} commit{{ staleness.behind === 1 ? `` : `s` }} since</span
            >
        </footer>
    </article>
</template>
