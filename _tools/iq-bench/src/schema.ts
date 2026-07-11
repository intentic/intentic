import { z } from "zod";

// Verbs whose output is ranked groups — the only ones golden-anchor scoring makes sense for.
// Anchor/git verbs (outline, context, recent, log, who) are excluded on purpose.
const SEARCH_VERBS = ["q", "find", "files", "def", "refs", "sym", "ast", "ask"] as const;

// Expected location. `line` omitted = file-level match; `tolerance` = ± lines accepted around `line`.
const AnchorSchema = z.object({
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
    tolerance: z.number().int().nonnegative().optional(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

const ScopeSchema = z.object({
    paths: z.array(z.string()).optional(),
    langs: z.array(z.string()).optional(),
    only: z.enum(["tests", "src", "docs", "config"]).optional(),
    notGlobs: z.array(z.string()).optional(),
});
export type CaseScope = z.infer<typeof ScopeSchema>;

const QueryCaseSchema = z.object({
    id: z.string().min(1),
    verb: z.enum(SEARCH_VERBS),
    query: z.string().min(2),
    scope: ScopeSchema.optional(),
    expected: z.array(AnchorSchema).min(1),
    // Provenance: how the expected anchors were verified.
    notes: z.string().optional(),
});
export type QueryCase = z.infer<typeof QueryCaseSchema>;

export const QueryDatasetSchema = z.object({
    // Matches repos.lock.json id; "intentic" = this monorepo checkout, no clone step.
    repo: z.string().min(1),
    // Merged into every case's scope (case fields win). The intentic dataset uses notGlobs here to keep the
    // bench's own dataset files — which contain the query strings verbatim — out of the searched corpus.
    scope: ScopeSchema.optional(),
    cases: z.array(QueryCaseSchema).min(1),
});
export type QueryDataset = z.infer<typeof QueryDatasetSchema>;

const RepoLockSchema = z.object({
    id: z.string().min(1),
    url: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    lang: z.string().min(1),
    note: z.string().optional(),
});
export type RepoLock = z.infer<typeof RepoLockSchema>;
export const ReposLockSchema = z.array(RepoLockSchema);

// ---- tier 2: agentic tasks ----

const AnchorsGraderSchema = z.object({
    kind: z.literal("anchors"),
    anchors: z.array(AnchorSchema).min(1),
    // false/absent = any expected anchor in the answer counts; true = all must appear.
    requireAll: z.boolean().optional(),
});
const TestGraderSchema = z.object({
    kind: z.literal("test"),
    command: z.string().min(1),
    timeoutMs: z.number().int().positive(),
});
export const TaskSchema = z.object({
    id: z.string().min(1),
    repo: z.string().min(1),
    type: z.enum(["locate", "fix"]),
    prompt: z.string().min(1),
    // Applied to the worktree before the agent starts (both arms) — e.g. a bug-introducing patch for fix tasks.
    setup: z.object({ patch: z.string().min(1) }).optional(),
    grader: z.discriminatedUnion("kind", [AnchorsGraderSchema, TestGraderSchema]),
    caps: z.object({
        maxTurns: z.number().int().positive(),
        timeoutMs: z.number().int().positive().optional(),
    }),
});
export type Task = z.infer<typeof TaskSchema>;

const VENDORS = ["claude", "codex", "grok"] as const;
export type Vendor = (typeof VENDORS)[number];

// One agent run = (task × vendor × arm). Optional metrics stay absent when a vendor doesn't report them —
// the report renders "—", never fabricates.
export const RunRecordSchema = z.object({
    runId: z.string(),
    taskId: z.string(),
    repo: z.string(),
    sha: z.string(),
    vendor: z.enum(VENDORS),
    model: z.string(),
    arm: z.string(),
    success: z.boolean(),
    graderDetail: z.string(),
    turns: z.number().optional(),
    tokensIn: z.number().optional(),
    tokensOut: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    costUsd: z.number().optional(),
    wallMs: z.number(),
    // Arm B/C only: iq index build time, kept out of the agent's clock.
    indexBuildMs: z.number().optional(),
    exitCode: z.number(),
    answer: z.string(),
    transcriptPath: z.string().optional(),
    timestamp: z.string(),
    caps: z.object({ maxTurns: z.number(), timeoutMs: z.number() }),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

// ---- tier 1: result rows (retrieval.jsonl) ----

const CaseScoreSchema = z.object({
    recallAt1: z.number(),
    recallAt5: z.number(),
    recallAt10: z.number(),
    mrr: z.number(),
    ndcg: z.number(),
    tokens: z.number(),
    latencyMs: z.number(),
});
export type CaseScore = z.infer<typeof CaseScoreSchema>;

const CaseRowSchema = z.object({
    repo: z.string(),
    config: z.string(),
    caseId: z.string(),
    verb: z.enum(SEARCH_VERBS),
    score: CaseScoreSchema.optional(),
    skipped: z.literal("models-missing").optional(),
});
export type CaseRow = z.infer<typeof CaseRowSchema>;
