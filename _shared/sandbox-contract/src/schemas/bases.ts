import { z } from "zod";

// A base: a read-only checkout of one repository at one commit, where a conversation started (or main's tip, or any
// commit), shared by every conversation that asks for that commit and removed once none uses it. The `base` command on
// the agent's PATH asks for one and runs a command in it, so "before" is one command and never touches the agent's own
// checkout (the daemon's src/conversations/worktrees/bases/base-checkouts.ts).

const FullShaSchema = z.string().regex(/^[0-9a-f]{40}$/u, "a full 40-character commit sha");

export const BaseAtSchema = z
    .union([z.literal("fork"), z.literal("main"), FullShaSchema])
    .describe("Which commit: `fork`, where the asking checkout's HEAD leaves the main line (the default); `main`, the main line's tip; or a full commit sha.");
export type BaseAt = z.infer<typeof BaseAtSchema>;

export const BaseAskSchema = z.object({
    gitDir: z.string().min(1).describe("The asking checkout's git common dir, absolute: which repository the base is of."),
    head: FullShaSchema.optional().describe("The asking checkout's HEAD, which `fork` is measured from."),
    at: BaseAtSchema.optional(),
});
export type BaseAsk = z.infer<typeof BaseAskSchema>;

export const BaseDropSchema = BaseAskSchema.partial().extend({
    all: z.boolean().optional().describe("Let go of every base this conversation holds, instead of the one the rest names."),
});
export type BaseDrop = z.infer<typeof BaseDropSchema>;

// What a seed did for one Cargo target of the base (build-outputs/warm-seed.ts SeedOutcome).
export const BaseWarmSchema = z.object({
    rel: z.string(),
    state: z.enum(["seeded", "skipped"]),
    from: z.string().optional(),
    reason: z.string().optional(),
});

export const BaseCheckoutSchema = z.object({
    repo: z.string().describe('The repository, as the workspace names it ("root" for the workspace\'s own).'),
    commit: FullShaSchema,
    path: z.string().describe("Where the base stands: the repository's root at that commit."),
    holders: z.array(z.string()).describe("The conversations that asked for it lately; it goes once none does."),
    usedAt: z.number().describe("When it was last asked for, epoch ms."),
});
export type BaseCheckout = z.infer<typeof BaseCheckoutSchema>;

export const BaseEnsuredSchema = BaseCheckoutSchema.extend({
    created: z.boolean().describe("Whether this ask made it, rather than finding it standing."),
    warm: z.array(BaseWarmSchema).describe("What each of its Cargo targets was seeded from, or why it was left cold."),
});
export type BaseEnsured = z.infer<typeof BaseEnsuredSchema>;
