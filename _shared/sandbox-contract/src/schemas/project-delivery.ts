import { z } from "zod";

// LANDED WORK DELIVERED TO THE OWNER'S FOLDER. A folder attached to this computer's own sandbox is copied one way into
// `/work/<name>`; when a conversation's work lands there, the daemon hands the same change to the machine agent that
// holds the folder, which applies it file by file under a restore point and never over an edit of the owner's own.
// The daemon asks (`deliverProject` on the device contract), the machine decides and writes; nothing an agent runs can
// call it, since it is a procedure of the device link and not one of its tools.

// One changed file, as the land changed it: `base` is the content the conversation started from, `next` what it
// landed. Both base64, null where the file did not exist (an addition has no base, a deletion no next). A rename
// arrives as a deletion and an addition.
export const DeliveredFileSchema = z.strictObject({
    path: z.string().min(1).describe("Folder-relative, `/`-separated, never `.`, `..`, a drive or a backslash."),
    kind: z.enum(["added", "modified", "deleted"]),
    base: z.string().nullable(),
    next: z.string().nullable(),
    // Set only when the landed file is executable; the owner's folder keeps its own bit otherwise.
    executable: z.boolean().optional(),
});
export type DeliveredFile = z.infer<typeof DeliveredFileSchema>;

// The whole of what a delivery may carry in one call, decoded; past it the daemon delivers nothing and says so, and the
// window's Bring back still reaches every file.
export const PROJECT_DELIVERY_MAX_BYTES = 32 * 1024 * 1024;

export const ProjectDeliverySchema = z.strictObject({
    // The sandbox folder the change landed in, exactly `/work/<name>`; the machine finds the folder paired with it.
    remoteDir: z.string().min(1),
    files: z.array(DeliveredFileSchema),
    // Which land this is, for the restore point's record and the machine's audit line.
    landing: z.strictObject({ agentId: z.string().min(1), title: z.string().optional() }),
});
export type ProjectDelivery = z.infer<typeof ProjectDeliverySchema>;

// Why a file was left as the owner's folder holds it. `edited`: the owner changed it too and the two would not merge
// cleanly (or it is not text). `link`: a link or a non-file stands on its path. `outside`: the path would leave the
// folder. `missing-git`: the change needed a three-way merge and this machine has no git to make one.
export const DeliveryConflictReasonSchema = z.enum(["edited", "link", "outside", "missing-git"]);
export type DeliveryConflictReason = z.infer<typeof DeliveryConflictReasonSchema>;

export const ProjectDeliveryResultSchema = z.object({
    // The restore point taken before the first write (`intentic-machine sync restore --point <id>` undoes it); absent
    // when nothing was written.
    point: z.string().optional(),
    // The folder on the machine, as the owner knows it.
    folder: z.string(),
    // Written as landed.
    applied: z.array(z.string()),
    // Written as a merge of the owner's edit and the landed change; `content` (base64) is what the folder now holds, so
    // the sandbox's copy can be brought to the same bytes.
    merged: z.array(z.object({ path: z.string(), content: z.string() })),
    // Already as landed in the folder; nothing written.
    already: z.array(z.string()),
    conflicts: z.array(z.object({ path: z.string(), reason: DeliveryConflictReasonSchema })),
});
export type ProjectDeliveryResult = z.infer<typeof ProjectDeliveryResultSchema>;

// What became of a land's delivery, kept on the conversation's landing record and shown on its card.
// - delivered: every file is in the folder as landed (or merged with the owner's edit).
// - partial: some were kept out, named in `conflicts`; the rest were written.
// - waiting: the computer holding the folder is not connected; it is delivered when it next is.
// - failed: the machine refused or broke; `reason` says why. Bring back still reaches the files.
// - too-large: past PROJECT_DELIVERY_MAX_BYTES; Bring back reaches the files.
export const LandingDeliveryStateSchema = z.enum(["delivered", "partial", "waiting", "failed", "too-large"]);
export type LandingDeliveryState = z.infer<typeof LandingDeliveryStateSchema>;

export const LandingDeliverySchema = z.object({
    state: LandingDeliveryStateSchema,
    at: z.number().describe("When this state was reached, in milliseconds."),
    // Which project folder of the workspace the land was delivered from (`my-app` for /work/my-app).
    project: z.string(),
    folder: z.string().optional().describe("The folder on the owner's computer, as its machine reported it."),
    applied: z.number().int().nonnegative().describe("Files written, merged ones included."),
    conflicts: z.array(z.object({ path: z.string(), reason: DeliveryConflictReasonSchema })),
    point: z.string().optional().describe("The machine's restore point taken before writing."),
    reason: z.string().optional().describe("Why it failed or waits, in a sentence."),
});
export type LandingDelivery = z.infer<typeof LandingDeliverySchema>;
