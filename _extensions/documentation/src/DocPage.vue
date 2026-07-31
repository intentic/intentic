<!-- One page of a document set: the prose, and the two things around it that only the app can add — clickable
     anchors into the workspace, and an honest line about how old this page is.

     The prose is rendered by the kit's <Markdown>, which is the same engine the chat and the file viewer use, so
     a document's figures, code blocks and file links behave here exactly as they do everywhere else. Nothing on
     this page is styled by the document: it authored meaning, the app draws it. -->
<script setup lang="ts">
import { Icon, Markdown, RowGroup, StatusBadge, timeAgo } from "@intentic/extension-ui";
import type { DocAnchor, DocIndexEntry, DocProvenance } from "./docModel.js";
import { host } from "./host.js";

const { prose, anchors, provenance, staleness } = defineProps<{
    prose: string | undefined;
    anchors: readonly DocAnchor[];
    provenance: DocProvenance | undefined;
    // This page's row in the generated index, when there is one — the tool's verdict on whether it is still true.
    staleness: DocIndexEntry | undefined;
}>();

/* An anchor opens the file in the workspace view. `line` is dropped on purpose: the workspace route addresses a
 * path, and appending a line it does not understand would produce a link that silently fails rather than one that
 * lands one screen away from the right place. */
const open = (anchor: DocAnchor): void => {
    host().navigate(`/workspace/${anchor.path}`);
};
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
        <!-- Staleness sits ABOVE the prose, because a reader who is about to trust a page needs to know first. It
             names the reason rather than just the verdict: "points at a file that is gone" and "12 commits behind"
             call for different actions. -->
        <div v-if="staleness?.stale === true" class="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
            <span class="text-content">This page may be out of date — {{ staleness.reason }}.</span>
        </div>

        <Markdown v-if="prose !== undefined" :source="prose" style="--prose-measure: 76ch" />
        <p v-else class="text-sm text-muted">This page has no prose yet.</p>

        <RowGroup v-if="anchors.length > 0" label="Where to start reading">
            <button
                v-for="anchor in anchors"
                :key="anchor.path"
                type="button"
                class="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-canvas"
                @click="open(anchor)"
            >
                <Icon name="file" class="mt-0.5 shrink-0 text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate font-mono text-xs text-link">{{ anchor.path }}<span v-if="anchor.line !== undefined">:{{ anchor.line }}</span></span>
                    <span class="text-2xs text-muted">{{ anchor.what }}</span>
                </span>
            </button>
        </RowGroup>

        <!-- Provenance is shown, not hidden in the JSON: "who wrote this, against what, when" is the first thing
             anyone asks of a generated document, and a page that cannot answer it does not deserve to be trusted. -->
        <footer v-if="provenance !== undefined" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-2xs text-subtle">
            <StatusBadge :variant="staleness?.stale === true ? `warning` : `neutral`" size="xs" dot :label="`written ${timeAgo(provenance.generatedAt)}`" />
            <span>against <span class="font-mono">{{ provenance.sourceRev.slice(0, 8) }}</span></span>
            <span v-if="provenance.model !== undefined">by {{ provenance.model }}</span>
            <span v-if="staleness !== undefined && staleness.behind > 0">· {{ staleness.behind }} commit{{ staleness.behind === 1 ? `` : `s` }} since</span>
        </footer>
    </div>
</template>
