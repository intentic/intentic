// audit: the sandbox's audit trail (historyRoot/audit/), who changed a policy, a member, a secret's gate or a setting,
// who signed in, and (when `settings.audit.recordReads` is on) who read what. Separate from the activity log, which
// records what team-chat bots sent and received. Every record carries the hash of the one before it, so a record
// changed, removed or inserted afterwards breaks the chain at that point, and /audit/verify names where.
import { z } from "zod";

// Who did it, as the daemon verified it, never as a client said it. A member is named by the address they signed in
// with and the tier they held at that moment; a program by its control token; an agent by its conversation; the
// sandbox itself (a retention sweep, a boot) as `system`.
export const AuditActorSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("member"),
        email: z.string().describe("The address they signed in with, lowercased."),
        role: z.string().describe("Their tier at the moment they acted: owner, maintainer, writer, collaborator, viewer or guest."),
    }),
    z.object({
        kind: z.literal("token"),
        id: z.string().describe("The control token's id."),
        label: z.string().describe("The name its owner gave the token."),
    }),
    z.object({ kind: z.literal("agent"), conversationId: z.string().describe("The conversation whose agent did it.") }),
    z.object({
        kind: z.literal("system"),
        reason: z.string().optional().describe("What part of the sandbox acted, such as a retention sweep or a change found in a file."),
    }),
]);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AUDIT_ACTION_MAX = 120;
export const AUDIT_TARGET_MAX = 500;

// What a module hands services.audit.record: the daemon fills in the id, the time and the chain.
export const AuditEventSchema = z.object({
    actor: AuditActorSchema,
    action: z
        .string()
        .min(1)
        .max(AUDIT_ACTION_MAX)
        .describe("What happened, as a dotted name: settings.change, member.grant, secret.gate.set, auth.sign_in, conversation.read."),
    target: z.string().max(AUDIT_TARGET_MAX).optional().describe("What it happened to: a member's address, a secret's name, a conversation id, a file's path."),
    outcome: z.enum(["ok", "refused", "failed"]).optional().describe("How it ended. Absent means it succeeded."),
    details: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("A few facts that make the record readable: which settings changed, a new role. Never a secret's value, and as little personal data as will do."),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// One line of a segment. `v` is the record format, so a later build that adds a field still verifies an older line:
// the hash is over exactly the fields the line holds.
export const AuditRecordSchema = AuditEventSchema.extend({
    v: z.literal(1).describe("The record format."),
    id: z.string().describe("The record's own id."),
    at: z.number().describe("When it was written, in milliseconds since 1970. Strictly increasing, so it is also what you page by."),
    prevHash: z.string().describe("The hash of the record before it, or of the checkpoint left by pruning, or 64 zeros for the first record ever written."),
    hash: z.string().describe("SHA-256, in hex, over this record's canonical JSON without `hash` itself."),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export const AuditQuerySchema = z.object({
    from: z.coerce.number().optional().describe("Only records written at or after this time, in milliseconds."),
    to: z.coerce.number().optional().describe("Only records written before this time, in milliseconds."),
    action: z.string().max(AUDIT_ACTION_MAX).optional().describe("Only actions starting with this, such as `member.` or `settings.change`."),
    actor: z.string().max(200).optional().describe("Only records whose actor's address, token name or conversation id contains this."),
    target: z.string().max(AUDIT_TARGET_MAX).optional().describe("Only records whose target contains this."),
    before: z.coerce.number().optional().describe("Paging cursor: only records written before this time. Pass the previous page's `next`."),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe("How many records to return."),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditListSchema = z.object({
    records: z.array(AuditRecordSchema).describe("The records, newest first."),
    next: z.number().optional().describe("The cursor for the next, older page. Absent on the last page."),
});
export type AuditList = z.infer<typeof AuditListSchema>;

export const AuditVerifySchema = z.object({
    ok: z.boolean().describe("Whether every record kept is intact and in an unbroken chain."),
    checked: z.number().describe("How many records were checked."),
    segments: z.number().describe("How many monthly files were checked."),
    prunedThrough: z
        .object({ at: z.number(), hash: z.string() })
        .optional()
        .describe("Where the kept chain starts: the time and hash of the last record retention deleted. Absent while nothing was ever deleted."),
    broken: z
        .object({
            segment: z.string().describe("The monthly file it is in."),
            line: z.number().describe("Its line number in that file, from 1."),
            id: z.string().optional().describe("The record's id, when the line could still be read."),
            at: z.number().optional().describe("When the record says it was written."),
            reason: z
                .enum(["unreadable", "hash-mismatch", "chain-break"])
                .describe(
                    "unreadable: the line is not a record. hash-mismatch: the record was changed after it was written. chain-break: a record before it was removed, inserted or reordered.",
                ),
        })
        .optional()
        .describe("The first record that does not check out. Absent when the chain is whole."),
    torn: z.boolean().describe("Whether the newest file ends in a half-written line, which a crash mid-write leaves. It is skipped, not counted as tampering."),
});
export type AuditVerify = z.infer<typeof AuditVerifySchema>;

export const AuditExportQuerySchema = z.object({
    from: z.coerce.number().describe("The first moment to include, in milliseconds."),
    to: z.coerce.number().describe("The moment to stop before, in milliseconds."),
});
export type AuditExportQuery = z.infer<typeof AuditExportQuerySchema>;

export const AuditExportSchema = z.object({
    filename: z.string().describe("A file name to save it under."),
    jsonl: z.string().describe("The records, one JSON object per line, oldest first, exactly as stored, so the hashes still check out."),
    count: z.number().describe("How many records it holds."),
});
export type AuditExport = z.infer<typeof AuditExportSchema>;

// The forwarder's state, so the settings page can say whether the outside copy is keeping up.
export const AuditStatusSchema = z.object({
    forwarding: z
        .object({
            url: z.string().describe("Where records are sent."),
            pending: z.number().describe("How many records are waiting to be sent."),
            lastSentAt: z.number().optional().describe("When the last record reached it."),
            lastError: z.string().optional().describe("Why the last attempt failed, when it did."),
            nextAttemptAt: z.number().optional().describe("When the next attempt is due, while it is backing off."),
        })
        .optional()
        .describe("Absent while no forward address is set."),
    oldestAt: z.number().optional().describe("When the oldest record kept was written."),
    segments: z.array(z.string()).describe("The monthly files kept, oldest first."),
});
export type AuditStatus = z.infer<typeof AuditStatusSchema>;
