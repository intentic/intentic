import { errorMessage } from "@intentic/ui/async";
import { reactive, type Ref, ref } from "vue";
import { collectDroppedFiles } from "../../workspace/explorer/transfer/dropEntries";
import { forgetPreview, rememberPreview } from "./attachmentPreviews";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { sandboxJsonVia, sandboxUpload } from "../../sandbox/client/sandboxClient";
import type { PendingAttachment } from "../session/conversation";
import type { ChatAttachment } from "../transcript/transcript";
import { uuid } from "../../../lib/uuid";

// Files staged for the next turn: the composer chips, arriving via paperclip dialog, paste, or drop. Per-tab like the
// draft, since the upload closure keeps pointing at its own entry rather than the list. Abandoned uploads orphan files
// under .intentic/records/artifacts/attachments, visible and deletable in the workspace tree.

export const useChatAttachments = (composer: {
    /** This pane's conversation's staged files. */
    readonly attachments: Ref<PendingAttachment[]>;
    /** No daemon, nowhere to put the bytes. */
    readonly reachable: Ref<boolean>;
    /** No account, no turn to attach them to. */
    readonly connected: Ref<boolean>;
    /** Which sandbox's disk these bytes live on; undefined means the active one. */
    readonly at: Ref<string | undefined>;
}) => {
    // Depth counter (enter/leave fire per descendant) drives the drop ring on this pane, not the whole panel.
    const dragDepth = ref(0);
    const takesFiles = (): boolean => composer.reachable.value && composer.connected.value;

    const attach = (file: File): void => {
        if (!composer.reachable.value) {
            return;
        }
        const controller = new AbortController();
        // reactive() explicitly: entries mutate through this reference (progress ticks), not the array ref's proxy.
        const previewUrl = file.type.startsWith(`image/`) ? URL.createObjectURL(file) : undefined;
        const entry = reactive<PendingAttachment>({
            id: uuid(),
            name: file.name,
            path: `.intentic/records/artifacts/attachments/${uuid()}/${file.name}`,
            controller,
            status: `uploading`,
            progress: 0,
            ...(previewUrl === undefined ? {} : { previewUrl }),
        });
        // Filed under the path too (attachmentPreviews), since a mid-turn message carries only a path, not a thumbnail.
        if (previewUrl !== undefined) {
            rememberPreview(entry.path, previewUrl);
        }
        composer.attachments.value = [...composer.attachments.value, entry];
        sandboxUpload(`/workspace/upload?path=${encodeURIComponent(entry.path)}`, file, {
            signal: controller.signal,
            ...(composer.at.value === undefined ? {} : { at: composer.at.value }),
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
                // Both halves; otherwise the cache keeps handing out a URL pointing at nothing.
                forgetPreview(attachment.path);
                URL.revokeObjectURL(attachment.previewUrl);
            }
            if (attachment.status === `done`) {
                // Fire-and-forget: drop the uploaded dir; a failure leaves the orphan visible and deletable in the
                // tree.
                const dir = attachment.path.slice(0, attachment.path.lastIndexOf(`/`));
                sandboxJsonVia(composer.at.value, `/workspace/entry`, jsonBody(`DELETE`, { path: dir })).catch(() => undefined);
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
            // Must run synchronously in the drop handler; a dropped folder is walked but attached flat.
            void collectDroppedFiles(event.dataTransfer).then(({ files }) => {
                for (const dropped of files) {
                    attach(dropped.file);
                }
            });
        },
        // The staged chips as the message carries them: upload metadata only, no thumbnail. A message is re-drawn from
        // the
        // daemon or the run's frame log, neither carrying an object URL; the thumbnail is filed under the path instead.
        snapshot: (): ChatAttachment[] => composer.attachments.value.map(({ name, path }): ChatAttachment => ({ name, path })),
    };
};
