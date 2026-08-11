<!-- FILL THE VPN FORM FROM THE FILE FORTICLIENT ALREADY WROTE.
     A user with an exported FortiClient config drops it here and picks a connection instead of re-keying its
     host, port and protocol per tunnel. The file is read IN THIS TAB and only its text is posted: the daemon
     cannot reach the user's Downloads folder, and asking someone to open an XML export and copy it out by hand
     was the step that made this feature not worth using.

     NOTHING IS STORED by any of this. The picked connection is handed to the form as an answer the user can
     still change, and the ordinary add below is what saves it. Credentials are never among the answers —
     FortiClient encrypts them with a key tied to the machine that exported them — so each row says which fields
     are still waiting. -->
<script setup lang="ts">
import { type ForticlientConnection } from "@intentic/sandbox-contract";
import { cmp, type NoticeModel, RowGroup } from "@intentic/ui";
import { ref } from "vue";
import { noticeFrom, noticeOf } from "../composables/useAsyncAction";
import { importForticlient } from "../composables/sandbox/useVpn";

const emit = defineEmits<{
    /** The connection to fill the form with. */
    pick: [connection: ForticlientConnection];
    /** What went wrong reading the file, on the page's own notice — or null to clear it before a fresh read. */
    notice: [notice: NoticeModel | null];
}>();

const connections = ref<ForticlientConnection[]>([]);
// The file the list came from — named back at the user, so a picker full of unfamiliar connections is
// attributable to what they dropped. Empty until one has been read successfully.
const fileName = ref(``);
const importing = ref(false);
const chooseFile = ref<HTMLInputElement>();

// A FortiClient backup is tens of KB of XML. Far past that, the drop was a slip — reading the file into this tab
// and posting it is the wrong answer to one.
const MAX_BYTES = 4_000_000;

const readFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined || importing.value) {
        return;
    }
    emit(`notice`, null);
    fileName.value = ``;
    connections.value = [];
    if (file.size > MAX_BYTES) {
        emit(`notice`, noticeOf(`${file.name} is far too big to be a FortiClient configuration — that looks like the wrong file.`));
        return;
    }
    importing.value = true;
    try {
        const xml = await file.text();
        // An empty file is "nothing to import", which the line under the zone already says — posting it would
        // trade that sentence for the route's validation error, which answers a question nobody asked.
        connections.value = xml.trim().length === 0 ? [] : await importForticlient(xml);
        fileName.value = file.name;
    } catch (err) {
        emit(`notice`, noticeFrom(err, `Could not read that FortiClient configuration.`));
    } finally {
        importing.value = false;
    }
};

// Only an OS-file drag offers anything here; a link or an image dragged around inside the app must not light the
// zone up as though it could be imported.
const offersFile = (event: DragEvent): boolean => event.dataTransfer?.types.includes(`Files`) ?? false;
// Depth, not a boolean: crossing onto the zone's own children fires dragleave on the zone, and a boolean would
// flicker the highlight off while the pointer is still inside it.
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
    // Clear the field (the File is already captured): re-picking the SAME file after re-exporting it fires no
    // `change` otherwise, and the zone would look dead.
    input.value = ``;
};

const protocolOf = (connection: ForticlientConnection): string => (connection.provider === `fortinet` ? `SSL-VPN` : `IPsec`);
</script>

<template>
    <RowGroup label="Import from FortiClient (optional)">
        <div class="flex flex-col gap-2 px-4 py-3">
            <p class="text-2xs text-muted">
                Drop an exported FortiClient configuration (File ▸ Settings ▸ Backup) here to fill the form from one of its connections. Passwords in
                that file are encrypted by FortiClient and can't be read — you'll still type those.
            </p>
            <!-- The zone IS the button, so the drag and the click share one target and there is no small "browse"
                 link beside it to aim at. -->
            <button
                type="button"
                :class="
                    cmp.emptyState(
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
                <!-- Hidden, never unmounted: dropping the line would shorten the zone under the pointer mid-drag,
                     and a cursor near its bottom edge would then leave and re-enter it in a loop. -->
                <span :class="['text-2xs text-subtle', importing || dragging ? 'invisible' : '']">or click to choose one</span>
            </button>
            <input ref="chooseFile" type="file" accept=".conf,.xml,text/xml,application/xml" class="hidden" @change="onPick" />
            <p v-if="fileName !== '' && connections.length === 0" class="text-2xs text-warning">No VPN connections found in {{ fileName }}.</p>
            <template v-if="connections.length > 0">
                <p class="text-2xs text-subtle">From {{ fileName }} — pick the connection to fill the form with.</p>
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
    </RowGroup>
</template>
