<!-- One page of a document set: the prose, and the two things around it that only the app can add — clickable
     anchors into the workspace, and an honest line about how old this page is.

     The prose is rendered by the kit's <Markdown>, which is the same engine the chat and the file viewer use, so
     a document's figures, code blocks and file links behave here exactly as they do everywhere else. Nothing on
     this page is styled by the document: it authored meaning, the app draws it. -->
<script setup lang="ts">
import { cmp, Icon, Markdown, StatusBadge, timeAgo } from "@intentic/extension-ui";
import type { DocAnchor, DocIndexEntry, DocProvenance } from "./docModel.js";
import { host } from "./host.js";

const { prose, anchors, provenance, repo, staleness } = defineProps<{
    prose: string | undefined;
    anchors: readonly DocAnchor[];
    provenance: DocProvenance | undefined;
    // Which repository the anchors are relative to — a document's paths are repo-relative (that is what
    // `intentic-docs validate` resolves them against), and the workspace route is root-relative.
    repo: string;
    // This page's row in the generated index, when there is one — the tool's verdict on whether it is still true.
    staleness: DocIndexEntry | undefined;
}>();

/* An anchor opens the file in the workspace view, under its repository: without that prefix every link on this
 * page missed by one segment in any workspace whose repo is not the tree root. `line` is dropped on purpose —
 * the workspace route addresses a path, and appending a line it does not understand would produce a link that
 * silently fails rather than one that lands one screen away from the right place. */
const open = (anchor: DocAnchor): void => {
    host().navigate(`/workspace/${repo === `` ? `` : `${repo}/`}${anchor.path}`);
};
</script>

<template>
    <!-- Its own scroll area, independent of the contents menu beside it — see DocsView. Keyed per page by the
         parent, so the fade is one page arriving rather than a list of them animating. -->
    <div class="animate-fade-in flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto scrollbar-thin">
        <!-- Staleness sits ABOVE the prose, because a reader who is about to trust a page needs to know first. It
             names the reason rather than just the verdict: "points at a file that is gone" and "12 commits behind"
             call for different actions.

             ONE LINE, NOT A PANEL. Most pages in a live repository are behind by a commit or two at any moment,
             so this is the ordinary condition of a document rather than an alarm about it — drawn as a bordered
             amber block it was the loudest thing on every page, which is both wrong and, being nearly always
             true, ignorable. The dot is the same amber as the sidebar's marks, so the two read as one fact. -->
        <p v-if="staleness?.stale === true" class="flex items-center gap-2 text-xs text-muted">
            <span class="size-1.5 shrink-0 rounded-full bg-warning/70" aria-hidden="true"></span>
            May be out of date — {{ staleness.reason }}.
        </p>

        <Markdown v-if="prose !== undefined" :source="prose" style="--prose-measure: 76ch" />
        <p v-else class="text-sm text-muted">This page has no prose yet.</p>

        <!-- The anchors are places to go, so they are drawn as a list of places: a quiet label and rows that
             light up under the pointer. The bordered card they used to sit in announced a panel of settings. -->
        <section v-if="anchors.length > 0" class="flex flex-col gap-0.5">
            <h2 :class="cmp.sectionLabel(`mb-1 text-2xs`)">Where to start reading</h2>
            <button
                v-for="anchor in anchors"
                :key="anchor.path"
                type="button"
                class="anchorrow flex w-full items-start gap-3 rounded-lg px-2.5 py-1.5 text-left"
                @click="open(anchor)"
            >
                <Icon name="file" class="mt-0.5 shrink-0 text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate font-mono text-xs text-link"
                        >{{ anchor.path }}<span v-if="anchor.line !== undefined">:{{ anchor.line }}</span></span
                    >
                    <span class="text-2xs text-muted">{{ anchor.what }}</span>
                </span>
            </button>
        </section>

        <!-- Provenance is shown, not hidden in the JSON: "who wrote this, against what, when" is the first thing
             anyone asks of a generated document, and a page that cannot answer it does not deserve to be trusted. -->
        <footer v-if="provenance !== undefined" class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-2xs text-subtle">
            <StatusBadge
                :variant="staleness?.stale === true ? `warning` : `neutral`"
                size="xs"
                dot
                :label="`written ${timeAgo(provenance.generatedAt)}`"
            />
            <span
                >against <span class="font-mono">{{ provenance.sourceRev.slice(0, 8) }}</span></span
            >
            <span v-if="provenance.model !== undefined">by {{ provenance.model }}</span>
            <span v-if="staleness !== undefined && staleness.behind > 0"
                >· {{ staleness.behind }} commit{{ staleness.behind === 1 ? `` : `s` }} since</span
            >
        </footer>
    </div>
</template>

<style scoped>
/* Same row idiom as the contents column beside it, and the same reason for the short transition: these are rows
   you sweep across, so the feedback has to land inside the sweep. */
.anchorrow {
    cursor: pointer;
    transition: background-color 0.09s ease-out;
}
.anchorrow:hover {
    background: color-mix(in srgb, var(--color-content) 5%, transparent);
}
.anchorrow:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-primary-500);
}
</style>
