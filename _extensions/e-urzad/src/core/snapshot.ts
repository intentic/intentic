import { z } from "zod";

// What the rail view shows, kept per connected card in its records directory: the last sync's lists and every proof
// saved. Plain data with no node imports, so the browser half can share the types.

export const CaseRowSchema = z.object({
    id: z.string(),
    sign: z.string().optional(),
    title: z.string(),
    status: z.string(),
    // The JRWA symbol, read off the case sign (unit.JRWA.number.year); EZD's list answer carries no JRWA field of its own.
    jrwa: z.string().optional(),
    deadline: z.string().optional(),
    started: z.string().optional(),
});
export type CaseRow = z.infer<typeof CaseRowSchema>;

export const TaskRowSchema = z.object({
    id: z.string(),
    flowId: z.string(),
    received: z.string(),
    status: z.string(),
    documentTitle: z.string(),
    caseSign: z.string().optional(),
    caseTitle: z.string().optional(),
    registryNumber: z.string().optional(),
});
export type TaskRow = z.infer<typeof TaskRowSchema>;

export const DeliveryRowSchema = z.object({
    id: z.string(),
    subject: z.string(),
    from: z.string(),
    received: z.string().optional(),
    status: z.string(),
    opened: z.boolean(),
    kind: z.string(),
    // Days left to collect a notice (Stub) before it counts as delivered anyway.
    daysToReceive: z.number().optional(),
    // The workspace folder its content and attachments were saved to, once opened.
    saved: z.string().optional(),
});
export type DeliveryRow = z.infer<typeof DeliveryRowSchema>;

export const ProofRowSchema = z.object({
    messageId: z.string(),
    evidenceId: z.string(),
    type: z.string(),
    eventDate: z.string().optional(),
    path: z.string(),
    sha256: z.string(),
    savedAt: z.string(),
});
export type ProofRow = z.infer<typeof ProofRowSchema>;

export const SavedFileSchema = z.object({ path: z.string(), sha256: z.string(), bytes: z.number() });
export type SavedFile = z.infer<typeof SavedFileSchema>;

export const ActionRowSchema = z.object({
    at: z.string(),
    key: z.string(),
    approvalId: z.string().optional(),
    // Who approved it, as the daemon recorded their sign-in; absent on a sandbox without sign-in and on older rows.
    approvedBy: z.string().optional(),
    outcome: z.string(),
});
export type ActionRow = z.infer<typeof ActionRowSchema>;

export const SnapshotSchema = z.object({
    card: z.string(),
    service: z.enum(["ezd-rp", "e-doreczenia"]),
    syncedAt: z.string().optional(),
    cases: z.array(CaseRowSchema).default([]),
    tasks: z.array(TaskRowSchema).default([]),
    deliveries: z.array(DeliveryRowSchema).default([]),
    proofs: z.array(ProofRowSchema).default([]),
    actions: z.array(ActionRowSchema).default([]),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const emptySnapshot = (card: string, service: Snapshot["service"]): Snapshot => ({ card, service, cases: [], tasks: [], deliveries: [], proofs: [], actions: [] });
