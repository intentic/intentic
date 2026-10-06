<script setup lang="ts">
import { inject } from "vue";
import { viewersOfPath } from "../../../workbench/presence/usePresence";
import PresenceAvatars from "../../../workbench/presence/PresenceAvatars.vue";
import { CHROME_SCOPE, contextTarget, HOISTED_CONTEXT, viewerActionsTarget } from "../files/viewerChrome";
import { useT } from "@intentic/ui/i18n";

// Presence avatars and viewer's own controls teleported into the tab row bar.
const t = useT();

const { path } = defineProps<{ path: string }>();

const hoisted = inject(HOISTED_CONTEXT, false);
// Which pane's bar this belongs to; the phone provides none and never teleports.
const scope = inject(CHROME_SCOPE, `main`);
</script>

<template>
    <Teleport defer :to="`#${contextTarget(scope)}`" :disabled="!hoisted">
        <!-- A band of its own is `viewerbar`, the container a viewer's controls size their words against (the tab row they
             ride when hoisted is `tabbar`, EditorPane). -->
        <div :class="hoisted ? `flex min-w-0 items-center gap-1.5` : `@container/viewerbar flex h-8 shrink-0 items-center gap-1.5 border-b border-line bg-card px-3`">
            <!-- Members looking at the same file as you, live. -->
            <PresenceAvatars :members="viewersOfPath(path)" :label="t(`workspace.fileBreadcrumb.alsoViewingFile`)" />
            <!-- Viewer's own controls, teleported in here. -->
            <div :id="viewerActionsTarget(scope)" class="flex shrink-0 items-center gap-1"></div>
            <slot />
        </div>
    </Teleport>
</template>
