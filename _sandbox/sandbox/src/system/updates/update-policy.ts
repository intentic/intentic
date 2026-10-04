import { join } from "node:path";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// The owner's say over taking a downloaded update by itself (auto-update.ts), and the one fact that has to outlive the
// restart it causes: which update this daemon handed the machine. Kept on the history volume beside the host's update
// markers and the skipped release, for the same reason as that skip: it is about which version runs on THIS machine and
// when it restarts, so it stays with the machine rather than travelling in a bundle.
const UpdatePolicySchema = z.object({
    // Absent is on: an owner who never touched the switch gets updates, and only an explicit "off" is written.
    auto: z.boolean().optional(),
    // No automatic update before this moment; absent when not paused.
    pausedUntil: z.number().optional(),
    // The update this daemon started by itself, written before the machine is asked: the version that comes up reads it
    // to say the restart happened unasked.
    applied: z.object({ at: z.number(), to: z.string().optional() }).optional(),
});
export type UpdatePolicy = z.infer<typeof UpdatePolicySchema>;
export const updatePolicyDocument = defineDocument({ root: "history", path: "update-policy.json", schema: UpdatePolicySchema });

export interface UpdatePolicyFile {
    readonly read: () => Promise<UpdatePolicy>;
    readonly setAuto: (on: boolean) => Promise<void>;
    // Undefined lifts the pause.
    readonly pause: (until: number | undefined) => Promise<void>;
    // Undefined forgets it: the machine answered without restarting, so no update of ours is coming.
    readonly applied: (applied: UpdatePolicy["applied"]) => Promise<void>;
}

// Opened wherever it is needed: every handle on the path shares its write queue.
export const fileUpdatePolicy = (historyRoot: string): UpdatePolicyFile => {
    const file = openDocument(updatePolicyDocument, join(historyRoot, updatePolicyDocument.path), { fallback: () => ({}) });
    const set = async (change: (current: UpdatePolicy) => UpdatePolicy): Promise<void> => {
        await file.update(change);
    };
    // Rebuilt rather than spread-and-deleted, so an absent field is absent from the file rather than `undefined` in it.
    const withField = <K extends keyof UpdatePolicy>(current: UpdatePolicy, key: K, value: UpdatePolicy[K] | undefined): UpdatePolicy => {
        const { [key]: _dropped, ...rest } = current;
        return value === undefined ? rest : { ...rest, [key]: value };
    };
    return {
        read: () => file.read(),
        // Only "off" is worth a line in the file; on is what absence already says.
        setAuto: (on) => set((current) => withField(current, "auto", on ? undefined : false)),
        pause: (until) => set((current) => withField(current, "pausedUntil", until)),
        applied: (applied) => set((current) => withField(current, "applied", applied)),
    };
};
