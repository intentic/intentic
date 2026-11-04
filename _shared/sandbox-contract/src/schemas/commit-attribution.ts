import { z } from "zod";

// WHO A COMMIT NAMES (2026-11-04). Every commit the daemon makes was `intentic <agent@intentic.dev>`, so nobody could
// trace work to the person who asked for it. Each value says how much of that person goes into history, and the
// default keeps every address out of git until the owner chooses, since a pushed commit publishes it for good:
// `person` makes them the author (intentic stays the committer), `trailer` keeps intentic the author and adds a
// `Co-authored-by:` line for them, `intentic` names nobody. A person is named only by the commit address they set
// themselves (`settings.commitIdentity`), never by their sign-in address. Read where commits are made
// (git/attribution/commit-attribution.ts) and in every agent's shell (agent/run/harness/turn-env.ts).
export const CommitAttributionSchema = z.enum(["person", "trailer", "intentic"]);
export type CommitAttribution = z.infer<typeof CommitAttributionSchema>;

// A name and address as a commit carries them.
export const GitPersonSchema = z.object({
    name: z.string().trim().min(1).max(120).describe("The name a commit shows, such as Ada Lovelace."),
    email: z.string().trim().email().max(254).describe("The address a commit shows. Pushed commits publish it; a provider's noreply address keeps yours private."),
});
export type GitPerson = z.infer<typeof GitPersonSchema>;

// The sandbox setting itself, declared here so settings.ts carries one line for it.
export const commitAttributionSetting = CommitAttributionSchema.default("trailer").describe(
    "How commits made here name the person behind them. `person`: they are the commit's author and intentic its committer. `trailer` (the default): intentic stays the author and a Co-authored-by line names them. `intentic`: commits name nobody. Either way a person is named only by the commit name and address they set themselves, never by the address they sign in with; until they set one, their commits name nobody.",
);

// The caller's own commit name and address on this sandbox, and what it would name them as when they have none: the
// connected git account's identity for the sandbox's owner (its noreply address when the account keeps its email
// private), nothing for anyone else. A suggestion is never used until they save it.
export const CommitIdentityStateSchema = z.object({
    identity: GitPersonSchema.optional().describe("The name and address your commits here carry. Absent until you set one, and until then your commits name nobody."),
    suggested: GitPersonSchema.optional().describe("What to offer you before you have set one: the connected git account's name and commit address, for the sandbox's owner. Never used until saved."),
    attribution: CommitAttributionSchema.describe("How this sandbox's commits use it (settings.commitAttribution)."),
});
export type CommitIdentityState = z.infer<typeof CommitIdentityStateSchema>;

export const CommitIdentityAnswerSchema = z.object({
    identity: GitPersonSchema.nullable().describe("The name and address your commits here carry; null forgets yours, and your commits name nobody again."),
});
export type CommitIdentityAnswer = z.infer<typeof CommitIdentityAnswerSchema>;
