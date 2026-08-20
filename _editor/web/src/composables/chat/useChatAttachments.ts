import { errorMessage } from "@intentic/ui/async";
import { reactive, type Ref, ref } from "vue";
import { collectDroppedFiles } from "../../pages/workspace/dropEntries";
import { jsonBody } from "../sandbox/jsonBody";
import { sandboxJson, sandboxUpload } from "../sandbox/sandboxClient";
import type { PendingAttachment } from "./conversation";
import type { ChatAttachment } from "./transcript";

/* FILES STAGED FOR THE NEXT TURN — the chips over the composer, and the three ways they get there: the paperclip
 * (a file dialog the pane opens), a paste, and a drop.
 *
 * Per-tab like the draft: `attachments` is this pane's conversation's, so a mid-upload tab switch leaves the
 * chip on the chat it was staged for. The upload closure keeps pointing at the entry rather than at the list,
 * which is what makes that true.
 *
 * ponytail: abandoned drafts orphan their uploads in .intentic/records/artifacts/attachments (visible and
 * deletable in the workspace tree); a daemon-side sweep of stale dirs is the upgrade path if they pile up. */

export const useChatAttachments = (composer: {
    /** This pane's conversation's staged files. */
    readonly attachments: Ref<PendingAttachment[]>;
    /** No daemon, nowhere to put the bytes. */
    readonly reachable: Ref<boolean>;
    /** No account, no turn to attach them to. */
    readonly connected: Ref<boolean>;
}) => {
    // Depth counter (enter/leave fire per descendant) drives the drop ring on this pane. Per PANE rather than
    // per panel: with several open, a dropped screenshot belongs to the chat it was dropped on.
    const dragDepth = ref(0);
    const takesFiles = (): boolean => composer.reachable.value && composer.connected.value;

    const attach = (file: File): void => {
        if (!composer.reachable.value) {
            return;
        }
        const controller = new AbortController();
        // reactive() explicitly: entries are mutated through this reference (progress ticks), not via the
        // array ref's proxy, so the raw object wouldn't trigger updates. The entry lands on the tab active at
        // attach time and this closure keeps pointing at it, so a mid-upload tab switch updates the right chip.
        const entry = reactive<PendingAttachment>({
            id: crypto.randomUUID(),
            name: file.name,
            path: `.intentic/records/artifacts/attachments/${crypto.randomUUID()}/${file.name}`,
            controller,
            status: `uploading`,
            progress: 0,
            ...(file.type.startsWith(`image/`) ? { previewUrl: URL.createObjectURL(file) } : {}),
        });
        composer.attachments.value = [...composer.attachments.value, entry];
        sandboxUpload(`/workspace/upload?path=${encodeURIComponent(entry.path)}`, file, {
            signal: controller.signal,
            onProgress: (loaded) => {
                entry.progress = file.size > 0 ? loaded / file.size : 1;
            },
        }).then(
            () => {
                entry.status = `done`;
            },
            (err: unknown) => {
                entry.status = `failed`;
                entry.error = errorMessage(err, `Upload failed.`);
            },
        );
    };

    return {
        dragDepth,
        attach,
        remove: (attachment: PendingAttachment): void => {
            attachment.controller?.abort();
            if (attachment.previewUrl !== undefined) {
                URL.revokeObjectURL(attachment.previewUrl);
            }
            if (attachment.status === `done`) {
                // Fire-and-forget: drop the uploaded uuid dir; on failure the orphan stays visible in the
                // workspace tree, deletable there.
                const dir = attachment.path.slice(0, attachment.path.lastIndexOf(`/`));
                sandboxJson(`/workspace/entry`, jsonBody(`DELETE`, { path: dir })).catch(() => undefined);
            }
            composer.attachments.value = composer.attachments.value.filter((entry) => entry.id !== attachment.id);
        },
        onPaste: (event: ClipboardEvent): void => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length === 0 || !composer.reachable.value) {
                return;
            }
            event.preventDefault();
            for (const file of files) {
                attach(file);
            }
        },
        onDragEnter: (event: DragEvent): void => {
            if (!takesFiles() || event.dataTransfer?.types.includes(`Files`) !== true) {
                return;
            }
            dragDepth.value += 1;
        },
        onDragLeave: (): void => {
            dragDepth.value = Math.max(0, dragDepth.value - 1);
        },
        onDrop: (event: DragEvent): void => {
            dragDepth.value = 0;
            if (!takesFiles() || event.dataTransfer === null) {
                return;
            }
            // collectDroppedFiles must be called synchronously in the drop handler (drag-store validity window).
            // A dropped folder is walked but attached flat — chat attachments carry no directory structure.
            void collectDroppedFiles(event.dataTransfer).then(({ files }) => {
                for (const dropped of files) {
                    attach(dropped.file);
                }
            });
        },
        /* The staged chips as the message carries them: upload metadata plus the object URL, so the bubble it
         * lands on shows the same thumbnail the chip did without re-reading the bytes. */
        snapshot: (): ChatAttachment[] =>
            composer.attachments.value.map(({ name, path, previewUrl }): ChatAttachment => ({
                name,
                path,
                ...(previewUrl !== undefined ? { previewUrl } : {}),
            })),
    };
};
