import { createHash } from "node:crypto";
import { SECRET_REFERENCE } from "@intentic/sandbox-contract/schemas/needs";
import type { SafetyVerdict } from "@intentic/sandbox-contract/policy/safety-policy";
import type { CommandJudge, JudgeFacts } from "../agent/tools/command-judge.js";

// Keep verdicts for the turn, keyed by everything handed to the judge. Metadata reads still happen on every use.
export const commandJudgments = (judge: CommandJudge | undefined, signal: AbortSignal) => {
    const judged = new Map<string, Promise<SafetyVerdict>>();
    return async (program: string, facts: JudgeFacts): Promise<SafetyVerdict> => {
        const prepared = SECRET_REFERENCE.test(program)
            ? { ...facts, secretReferences: await judge?.secretFacts?.(program, signal) ?? facts.secretReferences ?? [] }
            : facts;
        // Facts contain no values or approver identities. Hash the tuple to bound keys to 64 characters and avoid
        // retaining another copy of program text or metadata. JSON preserves field boundaries without separators.
        const key = createHash("sha256").update(JSON.stringify([program, prepared])).digest("hex");
        const existing = judged.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const asking = Promise.resolve().then(() => judge?.(program, prepared, signal) ?? Promise.reject(new Error(`no judge`)));
        judged.set(key, asking);
        // Rejections aren't cached, so a momentarily unreachable judge doesn't condemn every later command. This branch
        // only forgets the entry, ahead of any caller's reaction; callers still see the rejection through `asking`.
        asking.catch(() => judged.delete(key));
        return asking;
    };
};
