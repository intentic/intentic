<!-- Reference for what the install command creates, and the line that removes it again. -->
<script setup lang="ts">
import { Button, Code, CopyButton, commandLang, useOsPreference } from "@intentic/ui";
import { computed } from "vue";
import { desktopVersion } from "../../app/environments/desktop";
import { DESKTOP_DOWNLOADS } from "../../app/environments/desktopDownloads";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { cmdOs } = useOsPreference();

// Read INSIDE the desktop app, this panel is being read in the very thing it offers to download, so the two
// installers are hidden there. Nothing else about the panel changes: what the command does, and how to undo
// it, are the same facts whichever window is reading them.
const desktop = computed(() => desktopVersion() !== undefined);

/* `cleanup` is the undo, passed in because it tracks the same OS choice as the command itself. */
const { cleanup, downloads = true } = defineProps<{ cleanup: string; downloads?: boolean }>();
</script>

<template>
    <div class="flex flex-col gap-3">
        <p class="text-sm font-medium text-content">{{ t(`setup.setupRunDetails.whatDoes`) }}</p>
        <!-- ONE CLAUSE A LINE. -->
        <ul class="flex flex-col gap-2 text-xs leading-relaxed text-muted">
            <li class="flex items-start gap-2">
                <Icon name="box" class="mt-0.5 shrink-0 text-link" />
                <span class="min-w-0 flex flex-col gap-1">
                    <span>{{ t(`setup.setupRunDetails.startsSandboxIn`) }} <span class="text-content">Docker</span></span>
                    <a
                        href="https://docs.docker.com/get-docker/"
                        target="_blank"
                        rel="noreferrer"
                        class="inline-flex items-center gap-1 text-link hover:underline"
                    >
                        {{ t(`setup.setupRunDetails.installDockerYourself`) }} <Icon name="external-link" />
                    </a>
                </span>
            </li>
            <li class="flex items-start gap-2">
                <Icon name="cloud" class="mt-0.5 shrink-0 text-link" />
                <!-- The fabric changed under this line and the line did not: it named Cloudflare long after the box stopped dialling one. -->
                <span class="min-w-0"
                    >{{ t(`setup.setupRunDetails.dials`) }} <span class="text-content">{{ t(`setup.setupRunDetails.out`) }}</span>
                    {{ t(`setup.setupRunDetails.toReachBrowserNo`) }}</span
                >
            </li>
        </ul>

        <!-- A visible alternative to the terminal path, kept in the reference column where it can be weighed before somebody commits to the command. -->
        <div v-if="!desktop && downloads" class="flex flex-col gap-2 border-t border-line pt-3">
            <p class="text-xs text-subtle">{{ t(`setup.setupRunDetails.useDesktopApp`) }}</p>
            <div class="grid grid-cols-2 gap-2">
                <Button as="a" :href="DESKTOP_DOWNLOADS.windows" label="Windows" severity="secondary">
                    <template #icon><Icon name="download" /></template>
                </Button>
                <Button as="a" :href="DESKTOP_DOWNLOADS.linuxAppImage" label="Linux" severity="secondary">
                    <template #icon><Icon name="download" /></template>
                </Button>
            </div>
        </div>

        <!-- The undo. -->
        <div class="flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted">
            <!-- The copy button rides the label, not the command. -->
            <span class="flex items-center gap-2">
                <Icon name="undo" class="shrink-0 text-subtle" />
                {{ t(`setup.setupRunDetails.removesAll`) }}
                <CopyButton :text="cleanup" class="-my-1 ml-auto" />
            </span>
            <!-- Same highlighted block as the install command: the OS tab on the run step picks bash vs PowerShell. -->
            <Code :code="cleanup" :lang="commandLang(cmdOs)" :wrap="true" :copyable="false" />
        </div>
    </div>
</template>
