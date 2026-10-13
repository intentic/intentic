import { procedure } from "../protocol/route-meta.js";
import { AuditExportQuerySchema, AuditExportSchema, AuditListSchema, AuditQuerySchema, AuditStatusSchema, AuditVerifySchema } from "../schemas/audit.js";

// The audit trail (historyRoot/audit/): who changed what, who signed in, and, when the owner asks for it, who read
// what. Owner and maintainers only: the trail names every member and what they did. Read-only on purpose, the daemon
// is its only writer. Its settings ride on /settings (`audit`), so changing them is itself a recorded settings change.
export const auditContract = {
    list: procedure
        .route({
            method: "GET",
            path: "/audit",
            summary: "The audit trail",
            description:
                "Who changed a setting, a member, a secret's gate or a policy, who signed in, and, when reads are recorded, who opened what. Newest first, filtered and paged. Reading it is itself recorded when reads are.",
        })
        .meta({ floor: "maintainer" })
        .input(AuditQuerySchema)
        .output(AuditListSchema),
    verify: procedure
        .route({
            method: "GET",
            path: "/audit/verify",
            summary: "Check the audit trail for tampering",
            description:
                "Recomputes every record's hash and its link to the one before it. Names the first record that was changed, removed or inserted after it was written. It shows tampering; it cannot undo it, which is what the copy sent to a forward address is for.",
        })
        .meta({ floor: "maintainer" })
        .output(AuditVerifySchema),
    export: procedure
        .route({
            method: "GET",
            path: "/audit/export",
            summary: "Download the audit trail for a period",
            description: "The records written in a period as JSON Lines, exactly as stored, so whoever receives them can check the hashes themselves.",
        })
        .meta({ floor: "maintainer" })
        .input(AuditExportQuerySchema)
        .output(AuditExportSchema),
    status: procedure
        .route({
            method: "GET",
            path: "/audit/status",
            summary: "Whether the audit trail's outside copy keeps up",
            description: "Which monthly files are kept, the oldest record, and whether records are reaching the forward address.",
        })
        .meta({ floor: "maintainer" })
        .output(AuditStatusSchema),
};
