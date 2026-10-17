// What every Claude Code turn's environment pins, whatever the owner's settings say: CLI features the prompt and the
// chat depend on, which the CLI gates off or swaps out by default. Not owner-tunable.

// The checklist tools: newer models gate Task*/TodoWrite off by default, but the prompt and the reducer both depend on
// them.
const CHECKLIST_ENV = { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_CODE_ENABLE_TASKS: "1" } as const;

// Turns off the CLI's own switch to another model when the provider's safety classifier stops a response, so a flagged
// turn ends for the person to choose (2026-09-30: asked every time, the owner's call over switching automatically).
const REFUSAL_ENV = { CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1" } as const;

// `/code-review` reports its findings through the ReportFindings tool, which the chat draws as one card
// (review-findings.ts). Without the flag the review runs in a forked agent and its findings come back as prose.
const REVIEW_ENV = { CLAUDE_CODE_REPORT_FINDINGS: "1" } as const;

export const PINNED_ENV = { ...CHECKLIST_ENV, ...REFUSAL_ENV, ...REVIEW_ENV } as const;
