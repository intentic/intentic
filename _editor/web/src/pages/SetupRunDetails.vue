<!-- Everything about the install command that is worth KNOWING rather than doing: what it creates, and the
     one line that removes all of it again. The run step's reference material.

     It is a component because it renders in two places and must not be written twice. Above `xl` the setup page
     docks it in a column of its own beside the steps, where it is simply always visible; below `xl` there is no
     room for a second column, so the same content hangs off step 3's (i) hint. Only one of the two is ever
     visible: the other is display:none, and the hint's card is inside a v-if that a hidden trigger can never
     open, so nothing renders twice.

     The docked column is the whole point. As a hover card teleported to <body> this content landed ON the
     command it described: 288px of explanation over the one thing the step exists to hand you, on exactly the
     wide screens with room to spare. InfoHint's own header comment already names this failure mode and the
     remedy: put it in the layout, not over it (CredentialGuide reached the same conclusion for the capability
     forms). This is the third time, so the content moved out to where both surfaces can share it. -->
<script setup lang="ts">
import { Button, Code, CopyButton, commandLang, useOsPreference } from "@intentic/ui";
import { computed } from "vue";
import { DESKTOP_DOWNLOADS, desktopVersion } from "../environments/desktop";

const { cmdOs } = useOsPreference();

// Read INSIDE the desktop app, this panel is being read in the very thing it offers to download, so the two
// installers are hidden there. Nothing else about the panel changes: what the command does, and how to undo
// it, are the same facts whichever window is reading them.
const desktop = computed(() => desktopVersion() !== undefined);

/* `cleanup` is the undo, passed in because it tracks the same OS choice as the command itself.
 *
 * `downloads` is off wherever the step itself now leads with an installer for the reader's own machine: the
 * two offers were the same offer, and the one on the card is the one with a verb on it. It stays ON for the
 * reader whose card has no button: a Mac, or the cloud lane, where the app is nothing to do with the machine
 * being set up but is still the thing that will manage it afterwards. */
const { cleanup, downloads = true } = defineProps<{ cleanup: string; downloads?: boolean }>();
</script>

<template>
    <div class="flex flex-col gap-3">
        <p class="text-sm font-medium text-content">What this does</p>
        <!-- ONE CLAUSE A LINE. Each of these used to carry its own footnote (the container names, "nothing
             deployed", "runs as you, no root") and a reference panel nobody finishes reading answers nothing.
             The line naming the dotfiles it writes is gone outright: where a log lands is not a fact anybody
             is weighing while deciding whether to paste a command. -->
        <ul class="flex flex-col gap-2 text-xs leading-relaxed text-muted">
            <li class="flex items-start gap-2">
                <Icon name="box" class="mt-0.5 shrink-0 text-link" />
                <span class="min-w-0">Starts your sandbox in <span class="text-content">Docker</span></span>
            </li>
            <li class="flex items-start gap-2">
                <Icon name="cloud" class="mt-0.5 shrink-0 text-link" />
                <span class="min-w-0">Opens a <span class="text-content">private Cloudflare tunnel</span>, no inbound ports</span>
            </li>
        </ul>

        <!-- A visible alternative to the terminal path, kept in the reference column where it can be weighed
             before somebody commits to the command. The Linux vanity URL serves the AppImage, which works
             across distributions without asking the reader to choose a package format here. -->
        <div v-if="!desktop && downloads" class="flex flex-col gap-2 border-t border-line pt-3">
            <p class="text-xs text-subtle">Or use the desktop app</p>
            <div class="grid grid-cols-2 gap-2">
                <Button as="a" :href="DESKTOP_DOWNLOADS.windows" label="Windows" severity="secondary">
                    <template #icon><Icon name="download" /></template>
                </Button>
                <Button as="a" :href="DESKTOP_DOWNLOADS.linuxAppImage" label="Linux" severity="secondary">
                    <template #icon><Icon name="download" /></template>
                </Button>
            </div>
        </div>

        <div class="border-t border-line pt-3 text-xs leading-relaxed text-subtle">
            <p>Installs Docker if you haven't got it, asking first.</p>
            <a
                href="https://docs.docker.com/get-docker/"
                target="_blank"
                rel="noreferrer"
                class="mt-1 inline-flex items-center gap-1 text-link hover:underline"
            >
                Install Docker yourself <Icon name="external-link" />
            </a>
        </div>

        <!-- The undo. It used to sit on the card, on the argument that knowing the undo exists is worth a row of
             the install step: true, but it earned that row by being the only place it could go. Here it is
             permanently visible on a wide screen instead of one row among eight, and on a narrow one it is a tap
             away in the same panel as the rest of what running this means. -->
        <div class="flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted">
            <!-- The copy button rides the label, not the command. Beside the command it took ~25px off the
                 one line that has to survive intact, and a one-liner that wraps stops looking like a thing you
                 run: the docked column is sized (Setup.vue's aside) so the command clears its full width. -->
            <span class="flex items-center gap-2">
                <Icon name="undo" class="shrink-0 text-subtle" />
                Removes all of it
                <CopyButton :text="cleanup" class="-my-1 ml-auto" />
            </span>
            <!-- Same highlighted block as the install command: the OS tab on the run step picks bash vs
                 PowerShell, and this line tracks that choice via the parent's cleanup prop. -->
            <Code :code="cleanup" :lang="commandLang(cmdOs)" :wrap="true" :copyable="false" />
        </div>
    </div>
</template>
