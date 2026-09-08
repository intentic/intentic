<!--
    Fills the VPN add-form from a FortiClient export file read in this tab; only its text is sent, since the daemon cannot reach the user's
    filesystem. Nothing is stored — the picked connection only pre-fills the form below. Credentials are never included; FortiClient encrypts them to
    the exporting machine.
-->
<script setup lang="ts">
import type { ForticlientConnection } from "@intentic/sandbox-contract";
import { type NoticeModel, RowGroup, RowNote, ui } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { ref } from "vue";
import { importForticlient } from "../../sandbox/devices/useVpn";

const emit = defineEmits<{
    /** The connection to fill the form with. */
    pick: [connection: ForticlientConnection];
    /** What went wrong reading the file, on the page's own notice, or null to clear it before a fresh read. */
    notice: [notice: NoticeModel | null];
}>();

const connections = ref<ForticlientConnection[]>([]);
// File the list came from, shown back to the user; empty until one has been read successfully.
const fileName = ref(``);
const importing = ref(false);
const chooseFile = ref<HTMLInputElement>();

// A FortiClient backup is tens of KB; anything far larger means the wrong file was dropped.
const MAX_BYTES = 4_000_000;

const readFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined || importing.value) {
        return;
    }
    emit(`notice`, null);
    fileName.value = ``;
    connections.value = [];
    if (file.size > MAX_BYTES) {
        emit(`notice`, noticeOf(`${file.name} is far too big to be a FortiClient configuration: that looks like the wrong file.`));
        return;
    }
    importing.value = true;
    try {
        const xml = await file.text();
        // An empty file needs no import call: the zone's own line already says so, so skip the route's validation
        // error.
        connections.value = xml.trim().length === 0 ? [] : await importForticlient(xml);
        fileName.value = file.name;
    } catch (err) {
        emit(`notice`, noticeFrom(err, `Could not read that FortiClient configuration.`));
    } finally {
        importing.value = false;
    }
};

// Only an OS-file drag lights up the zone; a link or image dragged inside the app must not.
const offersFile = (event: DragEvent): boolean => event.dataTransfer?.types.includes(`Files`) ?? false;
// Depth, not a boolean: crossing onto the zone's own children fires dragleave, which a boolean would flicker on.
let dragDepth = 0;
const dragging = ref(false);

const onDragEnter = (event: DragEvent): void => {
    if (!offersFile(event)) {
        return;
    }
    dragDepth += 1;
    dragging.value = true;
};
const onDragLeave = (): void => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
        dragDepth = 0;
        dragging.value = false;
    }
};
const onDrop = (event: DragEvent): void => {
    dragDepth = 0;
    dragging.value = false;
    void readFile(event.dataTransfer?.files[0]);
};
const onPick = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    void readFile(input.files?.[0]);
    // Clears the field so re-picking the same file after re-exporting still fires `change`.
    input.value = ``;
};

const protocolOf = (connection: ForticlientConnection): string => (connection.provider === `fortinet` ? `SSL-VPN` : `IPsec`);
</script>

<template>
    <RowGroup label="Import from FortiClient (optional)">
        <RowNote variant="block">
            <div class="flex flex-col gap-2">
                <p class="text-2xs text-muted">
                    Drop an exported FortiClient configuration (File ▸ Settings ▸ Backup) here to fill the form from one of its connections. Passwords
                    in that file are encrypted by FortiClient and can't be read: you'll still type those.
                </p>
                <!-- The zone is the button itself: drag and click share one target, no separate browse link. -->
                <button
                    type="button"
                    :class="
                        ui.emptyState(
                            `flex cursor-pointer flex-col items-center gap-1 py-6 transition-colors`,
                            dragging ? `border-primary-500 bg-primary-500/5` : `hover:border-line-strong`,
                        )
                    "
                    :disabled="importing"
                    @click="chooseFile?.click()"
                    @dragenter.prevent="onDragEnter"
                    @dragover.prevent
                    @dragleave="onDragLeave"
                    @drop.prevent="onDrop"
                >
                    <Icon v-if="importing" name="spinner" spin class="text-lg text-info" />
                    <Icon v-else name="upload" :class="['text-lg', dragging ? 'text-primary-500' : 'text-muted']" />
                    <span class="text-xs text-content">
                        <template v-if="importing">Reading…</template>
                        <template v-else-if="dragging">Drop it to read its connections</template>
                        <template v-else>Drop the configuration file here</template>
                    </span>
                    <!--
                        Hidden, not unmounted: removing it would shrink the zone mid-drag and loop the pointer in and
                        out.
                    -->
                    <span :class="['text-2xs text-subtle', importing || dragging ? 'invisible' : '']">or click to choose one</span>
                </button>
                <input ref="chooseFile" type="file" accept=".conf,.xml,text/xml,application/xml" class="hidden" @change="onPick" />
                <p v-if="fileName !== '' && connections.length === 0" class="text-2xs text-warning">No VPN connections found in {{ fileName }}.</p>
                <template v-if="connections.length > 0">
                    <p class="text-2xs text-subtle">From {{ fileName }}: pick the connection to fill the form with.</p>
                    <div class="scrollbar-thin flex max-h-48 flex-col gap-0.5 overflow-auto">
                        <button
                            v-for="connection in connections"
                            :key="`${connection.provider}-${connection.id}`"
                            type="button"
                            class="flex flex-col gap-0.5 rounded-md bg-canvas px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-overlay"
                            @click="emit(`pick`, connection)"
                        >
                            <span class="flex items-baseline gap-2">
                                <span class="font-medium text-content">{{ connection.label }}</span>
                                <span class="text-2xs text-subtle">{{ protocolOf(connection) }}</span>
                                <span class="min-w-0 truncate font-mono text-2xs text-muted"> {{ connection.server }}:{{ connection.port }} </span>
                            </span>
                            <span class="text-2xs text-subtle">You'll need to enter: {{ connection.needs.join(", ") }}</span>
                        </button>
                    </div>
                </template>
            </div>
        </RowNote>
    </RowGroup>
</template>
