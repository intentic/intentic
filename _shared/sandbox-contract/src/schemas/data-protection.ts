// data-protection: what a sandbox needs to run under a data protection officer's rules (GDPR/RODO, Poland's KRI, the
// AI Act): how long what it keeps is kept, what its audit trail records and for how long, whether the product's own
// analytics may watch it, and the notice its members read about working with an AI. Every default here is what the
// sandbox did before these settings existed. A public office switches them on with the public-office preset on the
// data protection page, never through a changed default: most sandboxes belong to developers and individuals, and a
// stricter default would take away something they rely on.
import { z } from "zod";

export const RETENTION_DAYS_MAX = 3650;
const retentionDays = () => z.number().int().min(0).max(RETENTION_DAYS_MAX).default(0);

// One field per kind of copy the sandbox keeps of what people and agents wrote. Zero keeps that kind forever, which is
// what every sandbox did before this block existed. A positive value DELETES (it does not archive) once the copy is
// older than that many days, so a person's data asked to be forgotten is gone from every place it sat.
export const RetentionSettingsSchema = z.object({
    transcriptDays: retentionDays().describe(
        "How many days a conversation's transcript is kept after its last message. After that the transcript and its backups are deleted for good, not archived. Zero keeps them forever.",
    ),
    restorePointDays: retentionDays().describe(
        "How many days the workspace's restore points are kept. These are the snapshots taken every minute while agents work, so files deleted from the workspace stay recoverable until then. Zero keeps every restore point.",
    ),
    privacyVaultDays: retentionDays().describe(
        "How many days the privacy shield remembers a personal value after it last saw it. After that the value and its token are deleted, and the value is matched as new if it comes back. Zero remembers them forever.",
    ),
    cacheDays: retentionDays().describe(
        "How many days converted copies of documents are kept: text read out of PDFs and office files, and the results of reading scans and images. Zero keeps them until the cache needs the room.",
    ),
    rawOutputDays: retentionDays().describe(
        "How many days the full, untrimmed output of commands is kept beside the trimmed version the agent read. Zero keeps it until the space is needed.",
    ),
});
export type RetentionSettings = z.infer<typeof RetentionSettingsSchema>;

export const AUDIT_RETENTION_DAYS_MIN = 30;
export const AUDIT_RETENTION_DAYS_DEFAULT = 365;
// Poland's KRI regulation (Dz.U. 2024 poz. 773, §20) keeps a public system's logs for two years; the preset uses this.
export const AUDIT_RETENTION_DAYS_PUBLIC_OFFICE = 730;

// The audit trail: who changed a policy, a member, a secret's gate or a setting, and (when asked) who read what. It is
// separate from the activity log, which records the messages team-chat bots send and receive. It is hash-chained, so a
// changed or removed record shows, and it is written by the daemon alone, outside the agent's workspace.
export const AuditSettingsSchema = z.object({
    retentionDays: z
        .number()
        .int()
        .min(AUDIT_RETENTION_DAYS_MIN)
        .max(RETENTION_DAYS_MAX)
        .default(AUDIT_RETENTION_DAYS_DEFAULT)
        .describe(
            "How many days audit records are kept before the oldest are deleted. Public bodies in Poland keep system logs for two years (730 days).",
        ),
    recordReads: z
        .boolean()
        .default(false)
        .describe(
            "Also record who opened which conversation, transcript, file or log, not only who changed something. Off by default because it writes a record on every page someone opens.",
        ),
    forwardUrl: z
        .union([z.literal(""), z.url({ protocol: /^https$/ })])
        .default("")
        .describe(
            "An HTTPS address each audit record is also sent to as it is written, such as your organisation's log collector (SIEM). A copy kept outside the sandbox is the one nobody inside it can change. Empty sends nothing.",
        ),
    forwardSecret: z
        .string()
        .max(200)
        .default("")
        .describe(
            "The name of a stored secret sent as a bearer token with each forwarded record. Empty sends none.",
        ),
});
export type AuditSettings = z.infer<typeof AuditSettingsSchema>;

export const AI_NOTICE_TEXT_MAX = 4000;

// The AI Act's literacy duty (Art. 4) falls on whoever puts staff in front of an AI system. This is the card that tells
// them, once, what they are working with. Off by default: a developer does not need to be told, and the preset turns
// it on.
export const AiNoticeSchema = z.object({
    show: z
        .boolean()
        .default(false)
        .describe(
            "Show members a short notice the first time they open this sandbox: that they are working with an AI, that it makes mistakes, what to check before acting on its answers, and what not to paste into it. They confirm it once, and the confirmation is recorded.",
        ),
    text: z
        .string()
        .max(AI_NOTICE_TEXT_MAX)
        .default("")
        .describe(
            "Your own wording for that notice, such as your office's rules for using AI. Empty shows the built-in text in the reader's language.",
        ),
});
export type AiNotice = z.infer<typeof AiNoticeSchema>;

// Where the key that encrypts the sandbox's stores at rest (secrets, the credential vault, the privacy shield's vault)
// is read from: a file path in the daemon's environment, normally a secret mounted from outside the sandbox's volumes.
// Unset, those stores stay plain files readable only by their owner, as they always were.
export const AT_REST_KEY_FILE_ENV = "INTENTIC_AT_REST_KEY_FILE";
