import { createHash } from "node:crypto";

// Which arm of a mechanism's A/B experiment one conversation (a sandbox conversation, a Claude Code session) runs on.
// Deterministic per id with no state stored, so every turn of a conversation, and every process reading it back later,
// draws the same arm. `experiment` salts the hash so two experiments draw independent buckets for the same id instead of
// always agreeing, and a salt is never renamed: a new one re-draws every running conversation.

// True is the treated arm, false the held-out control. With no id to hash the draw is per call, which is the most a
// caller that cannot name its conversation can honestly get.
export const experimentArm = (experiment: string, id: string | undefined, holdout: number): boolean => {
    if (id === undefined) {
        return Math.random() >= holdout;
    }
    const bucket = createHash("sha256").update(`${experiment}:${id}`).digest().readUInt32BE(0) / 0x1_0000_0000;
    return bucket >= holdout;
};
