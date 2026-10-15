import { z } from "zod";
import type { DeliveryRow } from "../core/snapshot.js";

// The parts of e-Doręczenia UA API v3 (OpenAPI uaapi_3.0.8, published as uaapi_3.0.8.2.zip by Poczta Polska) and SE API
// v4 (se-api_v.4.0.5.yaml, embedded in COI's SE API V4 design document on gov.pl) answers this client reads. Loose
// objects: everything else the API sends is kept for the agent.

const text = z.string().nullish().transform((value) => value ?? undefined);

const AddressDataSchema = z.looseObject({ eDeliveryAddress: text });

const FileMetadataSchema = z.looseObject({ fileId: z.string().nullish(), filename: text, contentType: text, size: z.number().nullish() });

export const AttachmentSchema = z.looseObject({
    order: z.number().nullish(),
    attachmentId: text,
    file: z.looseObject({ fileMetadata: FileMetadataSchema.nullish(), file: text }).nullish(),
});
export type UaAttachment = z.infer<typeof AttachmentSchema>;

export const EvidenceSchema = z.looseObject({
    evidenceId: z.string(),
    messageId: z.string(),
    type: text,
    eventDate: text,
    createDate: text,
    downloaded: z.boolean().nullish(),
});
export type UaEvidence = z.infer<typeof EvidenceSchema>;

export const MessageSchema = z.looseObject({
    messageMetadata: z
        .looseObject({
            messageId: text,
            subject: text,
            from: AddressDataSchema.nullish(),
            to: z.array(AddressDataSchema).nullish(),
            timestamp: text,
            receiptDate: text,
            submissionDate: text,
            eventDate: text,
            shippingService: text,
        })
        .nullish(),
    messageControlData: z
        .looseObject({
            status: text,
            statusDescription: text,
            opened: z.boolean().nullish(),
            messageType: text,
            daysToReceive: z.number().nullish(),
            messageTaskId: text,
        })
        .nullish(),
    textBody: text,
    attachments: z.array(AttachmentSchema).nullish(),
    evidences: z.array(EvidenceSchema).nullish(),
});
export type UaMessage = z.infer<typeof MessageSchema>;

// MessagesWrapper (GET /{ade}/messages).
export const MessagesSchema = z.looseObject({ messages: z.array(MessageSchema), total: z.number().nullish(), warning: text });

// GET /{ade}/messages/{id}: 200 is Message[]; 202 is MessagePending while a notice is turned into the message.
export const MessageListSchema = z.array(MessageSchema);
export const PendingSchema = z.looseObject({ status: z.string() });

export const EvidencesSchema = z.looseObject({ evidences: z.array(EvidenceSchema).nullish(), warning: text });

// MessageInfo: what a send answers. The send is a task; delivery is proven only by evidence that comes later.
export const SendAnswerSchema = z.looseObject({ messageTaskId: z.string(), warning: text });

export const TaskStatusSchema = z.looseObject({ messageTaskStatus: z.string() });

export const deliveryRow = (message: UaMessage): DeliveryRow | undefined => {
    const metadata = message.messageMetadata;
    const control = message.messageControlData;
    if (metadata?.messageId === undefined) {
        return undefined;
    }
    return {
        id: metadata.messageId,
        subject: metadata.subject ?? "",
        from: metadata.from?.eDeliveryAddress ?? "",
        received: metadata.receiptDate ?? metadata.timestamp ?? metadata.submissionDate,
        status: control?.status ?? control?.statusDescription ?? "",
        opened: control?.opened === true,
        kind: control?.messageType ?? "Message",
        daysToReceive: control?.daysToReceive ?? undefined,
    };
};

// Which evidence file endpoint serves an evidence: hybrid (PUH, H.*) or electronic (PURDE, everything else).
export const evidenceService = (type: string | undefined): "puh" | "purde" => (type?.startsWith("H") === true ? "puh" : "purde");
