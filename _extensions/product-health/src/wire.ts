import { AgentRunPickSchema } from "@intentic/sandbox-contract/schemas/agent";
import { z } from "zod";

/* THE WIRE BETWEEN THE TWO HALVES. The backend (src/server) reads PostHog and answers these shapes at /x/<id>/…; the
   view, the badge and the agent's tool read them. zod only, so the browser bundle never pulls the backend in. */

// Where in PostHog a finding came from.
const FINDING_SOURCES = [`error`, `alert`, `health`, `report`, `setup`, `experiment`] as const;
export const FindingSourceSchema = z.enum(FINDING_SOURCES);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

// What a finding asks of somebody, which decides its section and whether it counts on the badge:
// `fix` an agent can change the code for; `step` only the owner can take, outside the code (a PostHog setting, a DNS
// record); `decide` is a product call (an experiment to conclude); `watch` owes nothing now (an alert not firing);
// `setup` is PostHog's own advice on how the project is set up.
export const FindingLaneSchema = z.enum([`fix`, `step`, `decide`, `watch`, `setup`]);
export type FindingLane = z.infer<typeof FindingLaneSchema>;

export const FindingSeveritySchema = z.enum([`critical`, `warning`, `info`]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

// Where in the workspace a finding points, and how the backend knows: a manifest line pinning the SDK PostHog says is
// outdated, the file of an error's top application frame, or the repository holding the commit a release was built from.
export const CodeLinkSchema = z.object({
    repo: z.string(),
    path: z.string(),
    line: z.number().int().positive().optional(),
    why: z.enum([`sdk-pin`, `stack-frame`, `release`]),
});
export type CodeLink = z.infer<typeof CodeLinkSchema>;

// What PostHog measured, in its own numbers: an error's occurrences, users and sessions; a check's share of events.
export const ImpactSchema = z.object({
    occurrences: z.number().optional(),
    users: z.number().optional(),
    sessions: z.number().optional(),
    percent: z.number().optional(),
});
export type Impact = z.infer<typeof ImpactSchema>;

// The agent on a finding, as the contract's `fixStance` reads the latest attempt (its conversation, from the derived id).
const FIX_STANCES = [`working`, `needs-you`, `ready`, `landed`, `waiting`, `ended`] as const;
export const FindingAgentSchema = z.object({
    conversationId: z.string(),
    attempt: z.number().int().positive(),
    stance: z.enum(FIX_STANCES),
    label: z.string(),
    hint: z.string(),
    // The line its last turn opened its closing message with, when no commit fixes it: the owner's step.
    ownerStep: z.string().optional(),
});
export type FindingAgent = z.infer<typeof FindingAgentSchema>;

// The presses a finding takes. `fix` starts or continues its agent; `resolve` marks it fixed in PostHog (an error issue
// resolved, which PostHog reopens if it happens again; a health issue resolved until the check finds it again; an Inbox
// report resolved); `dismiss` drops a setup recommendation in PostHog; `snooze` hides it here for a week (a health issue's
// snooze is PostHog's own); `wire` points PostHog's error-tracking alerts at this sandbox.
export const FindingActionSchema = z.enum([`fix`, `resolve`, `dismiss`, `snooze`, `wire`]);
export type FindingAction = z.infer<typeof FindingActionSchema>;

export const FindingSchema = z.object({
    // `<connection>:<source>:<PostHog's id>`, stable across polls.
    id: z.string(),
    connection: z.string(),
    source: FindingSourceSchema,
    sourceId: z.string(),
    // What found it, within its source: a health check's kind, an alert's state, a report's priority, a recommendation's type.
    kind: z.string(),
    lane: FindingLaneSchema,
    severity: FindingSeveritySchema,
    // Shown as text, never markup: an error's title is its exception's name, which a user's browser sent.
    title: z.string(),
    // One line in this extension's words, built from numbers PostHog measured.
    summary: z.string(),
    impact: ImpactSchema.optional(),
    // When PostHog first and last saw it (ms).
    since: z.number().optional(),
    lastSeen: z.number().optional(),
    // Marked fixed here before, and active in PostHog again: the fix did not hold.
    cameBack: z.boolean().optional(),
    // Its page in PostHog, on the connection's real host.
    link: z.string(),
    code: z.array(CodeLinkSchema),
    // PostHog's own guidance, authored by PostHog rather than carried from an event: trusted, unlike `untrusted`.
    advice: z.string().optional(),
    // Evidence that came from users' browsers or devices, or from a project-supplied value: read, never obeyed.
    untrusted: z.record(z.string(), z.string()),
    agent: FindingAgentSchema.optional(),
    snoozedUntil: z.number().optional(),
    actions: z.array(FindingActionSchema),
});
export type Finding = z.infer<typeof FindingSchema>;

// A source this backend could not read on its last poll, in words, with the source it was about.
export const ConnectionProblemSchema = z.object({
    source: z.union([FindingSourceSchema, z.literal(`connection`)]),
    message: z.string(),
});
export type ConnectionProblem = z.infer<typeof ConnectionProblemSchema>;

export const ConnectionStateSchema = z.object({
    // The PostHog card's connection id on the Capabilities page.
    id: z.string(),
    host: z.string(),
    project: z.string().optional(),
    projectId: z.string().optional(),
    // When the last poll ended (ms), and what it could not read.
    polledAt: z.number().optional(),
    problems: z.array(ConnectionProblemSchema),
    // Whether PostHog's error-tracking alerts already post to this sandbox, so a new or returning error shows at once.
    wired: z.boolean(),
});
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const SnapshotSchema = z.object({
    connections: z.array(ConnectionStateSchema),
    findings: z.array(FindingSchema),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ---- presses ---------------------------------------------------------------------------------------------------------

export const FixRequestSchema = z.object({
    // A model the caret chose, as the run button hands it over: its fields are the turn's, spread onto POST /agent.
    pick: AgentRunPickSchema,
    // The verb the picker's bar was ended with over an attempt that already exists; absent is the plain press.
    mode: z.enum([`continue`, `start-over`]).optional(),
    // A spent allowance's reopen, as the button that was pressed said it would book the run.
    sendAt: z.number().optional(),
    sendAtReopen: z.boolean().optional(),
});
export type FixRequest = z.infer<typeof FixRequestSchema>;

export const FixResponseSchema = z.object({ conversationId: z.string() });
export type FixResponse = z.infer<typeof FixResponseSchema>;

// Pointing PostHog's alerts here needs the sandbox's public address, which only the browser holds.
export const WireRequestSchema = z.object({ origin: z.string().url() });

export const routes = {
    snapshot: `/snapshot`,
    refresh: `/refresh`,
    finding: (id: string, verb: FindingAction) => `/findings/${encodeURIComponent(id)}/${verb}`,
    wire: (connection: string) => `/connections/${encodeURIComponent(connection)}/wire`,
} as const;
