<script setup lang="ts">
import { Segmented } from "@intentic-app/ui";
import { ref } from "vue";
import CodeView from "./CodeView.vue";
import ImageView from "./ImageView.vue";

/* SVG viewer: renders the image (default) with a Source toggle for the raw markup. The render uses an <img>
 * with a blob: object URL — loading SVG as an image keeps any embedded <script>/onload inert, so this is
 * XSS-safe. NEVER inline SVG markup via v-html: that is an active context where scripts execute (stored XSS
 * from a workspace file). The source view shows the markup highlighted as XML. */

defineProps<{ src: string; source: string }>();
const view = ref<`preview` | `source`>(`preview`);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex shrink-0 items-center border-b border-line px-2 py-1.5">
            <Segmented
                v-model="view"
                :options="[
                    { label: `Preview`, value: `preview` },
                    { label: `Source`, value: `source` },
                ]"
            />
        </div>
        <div class="min-h-0 flex-1">
            <ImageView v-if="view === 'preview'" :src="src" />
            <CodeView v-else :code="source" lang="xml" />
        </div>
    </div>
</template>
