import { type JsonObject, JsonObjectSchema } from "../core/json.js";
import type { OfficeRecords } from "../core/records.js";
import type { DeliveryRow, ProofRow, SavedFile } from "../core/snapshot.js";
import type { EdClient } from "./mailbox.js";
import { deliveryRow, type UaAttachment, type UaMessage } from "./mailbox-schemas.js";

// What the e-Doręczenia commands do with what the client fetched: keep the inbox list for the view, save an opened
// delivery and its attachments, and save evidence documents as proofs beside the delivery they prove.

export const syncInbox = async (client: EdClient, records: OfficeRecords, limit = 500): Promise<DeliveryRow[]> => {
    const fetched = (await client.inbox(limit)).flatMap((message) => {
        const row = deliveryRow(message);
        return row === undefined ? [] : [row];
    });
    const snapshot = await records.update((current) => {
        const saved = new Map(current.deliveries.map((row) => [row.id, row.saved]));
        return { ...current, syncedAt: new Date().toISOString(), deliveries: fetched.map((row) => ({ ...row, saved: saved.get(row.id) })) };
    });
    return snapshot.deliveries;
};

const attachmentName = (attachment: UaAttachment, index: number): string => {
    const name = attachment.file?.fileMetadata?.filename ?? attachment.attachmentId ?? `attachment-${index + 1}`;
    return `${String(attachment.order ?? index + 1).padStart(2, "0")}-${name}`;
};

// The message as received, minus the inline attachment bodies (saved as files beside it), as plain JSON.
const withoutBodies = (message: UaMessage): JsonObject => {
    const attachments = (message.attachments ?? []).map((attachment) => ({ ...attachment, file: { fileMetadata: attachment.file?.fileMetadata ?? null } }));
    return JsonObjectSchema.parse(JSON.parse(JSON.stringify({ ...message, attachments })));
};

export interface SavedDelivery {
    readonly messageId: string;
    readonly folder: string;
    readonly message: SavedFile;
    readonly attachments: readonly SavedFile[];
    readonly subject: string;
    readonly from: string;
}

export const saveOpened = async (client: EdClient, records: OfficeRecords, messageId: string, message: UaMessage): Promise<SavedDelivery> => {
    const folder = ["deliveries", messageId];
    const attachments: SavedFile[] = [];
    for (const [index, attachment] of (message.attachments ?? []).entries()) {
        const inline = attachment.file?.file;
        const bytes =
            inline === undefined || inline === ""
                ? attachment.attachmentId === undefined
                    ? undefined
                    : (await client.attachment(messageId, attachment.attachmentId)).bytes
                : new Uint8Array(Buffer.from(inline, "base64"));
        if (bytes !== undefined) {
            attachments.push(await records.save(folder, attachmentName(attachment, index), bytes));
        }
    }
    const saved = await records.save(folder, "message.json", new Uint8Array(Buffer.from(`${JSON.stringify(withoutBodies(message), undefined, 2)}\n`)));
    const directory = saved.path.slice(0, saved.path.lastIndexOf("/"));
    const row = deliveryRow(message);
    await records.update((current) => ({
        ...current,
        deliveries: current.deliveries.some((entry) => entry.id === messageId)
            ? current.deliveries.map((entry) => (entry.id === messageId ? { ...entry, ...row, opened: true, saved: directory } : entry))
            : row === undefined
              ? current.deliveries
              : [{ ...row, opened: true, saved: directory }, ...current.deliveries],
    }));
    return { messageId, folder: directory, message: saved, attachments, subject: row?.subject ?? "", from: row?.from ?? "" };
};

const extensionFor = (contentType: string): string => (contentType.includes("pdf") ? "pdf" : contentType.includes("zip") ? "zip" : "xml");

// Every evidence the operator issued for a message (or one), saved under proofs/<message>/ and listed for the view.
// e-Doręczenia names them by ETSI EN 319 522 type (A.1 accepted for sending, E.1 delivered, …) and as the
// potwierdzenie wysłania / otrzymania (BP.WX/BP.WP, BP.OX/BP.OP); the type is kept exactly as the API gives it.
export const saveProofs = async (client: EdClient, records: OfficeRecords, messageId: string, evidenceId?: string): Promise<ProofRow[]> => {
    const evidences = (await client.evidences(messageId)).filter((evidence) => evidenceId === undefined || evidence.evidenceId === evidenceId);
    if (evidenceId !== undefined && evidences.length === 0) {
        throw new Error(`message ${messageId} has no evidence ${evidenceId}`);
    }
    const saved: ProofRow[] = [];
    for (const evidence of evidences) {
        const file = await client.evidenceFile(evidence);
        const type = evidence.type ?? "unknown";
        const stored = await records.save(["proofs", messageId], `${type}-${evidence.evidenceId}.${extensionFor(file.contentType)}`, file.bytes);
        saved.push({ messageId, evidenceId: evidence.evidenceId, type, eventDate: evidence.eventDate ?? evidence.createDate, path: stored.path, sha256: stored.sha256, savedAt: new Date().toISOString() });
    }
    await records.update((current) => ({ ...current, proofs: [...saved, ...current.proofs.filter((proof) => !saved.some((entry) => entry.evidenceId === proof.evidenceId))] }));
    return saved;
};
