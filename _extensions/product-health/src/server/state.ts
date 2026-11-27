import { randomBytes } from "node:crypto";
import type { ServerDocument } from "@intentic/extension-api";
import { z } from "zod";
import { ConnectionStateSchema, FindingSchema } from "../wire.js";

/* WHAT THE BACKEND KEEPS between polls and restarts, in its own state directory (`api.document`, never the workspace):
   the last poll's findings per connection, what it marked or claimed in PostHog, what the owner snoozed here, the
   detail it already read once (a health check's guidance, an error's top frame and release), and the token in the
   address PostHog's alerts post to. None of it is a credential: the key stays in the daemon's connection store. */

// A detail read once is read again after this long, so a PostHog that improved its guidance is heard.
export const DETAIL_TTL_MS = 24 * 60 * 60_000;

const HealthDetailSchema = z.object({
    at: z.number(),
    title: z.string().optional(),
    summary: z.string().optional(),
    link: z.string().optional(),
    human: z.string().optional(),
    agent: z.string().optional(),
});
export type HealthDetail = z.infer<typeof HealthDetailSchema>;

const ErrorDetailSchema = z.object({
    at: z.number(),
    frame: z.object({ function: z.string().optional(), source: z.string(), line: z.number().optional() }).optional(),
    release: z.object({ version: z.string().optional(), commit: z.string().optional(), repo: z.string().optional() }).optional(),
});
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

export const StateSchema = z.object({
    // The secret path segment PostHog's alerts post to (door.ts): anyone without it is refused before a poll is spent.
    hookToken: z.string().min(32),
    // Findings marked fixed from here, with when: one active again came back.
    resolved: z.record(z.string(), z.number()).default({}),
    // Findings the owner snoozed here, until when.
    snoozed: z.record(z.string(), z.number()).default({}),
    // The claim PostHog handed out when an agent of this sandbox took an Inbox report, by finding.
    claims: z.record(z.string(), z.string()).default({}),
    // The `Owner step:` line an attempt's last turn ended on, by conversation (fix.ts).
    ownerSteps: z.record(z.string(), z.string()).default({}),
    // The conversation an automation's wake on a finding opened (wake.ts): its agent, when no Fix press started one.
    woken: z.record(z.string(), z.string()).default({}),
    // When each finding was first seen, so a wake fires once, when it appears; pruned once it has been gone a while.
    seen: z.record(z.string(), z.number()).default({}),
    healthDetails: z.record(z.string(), HealthDetailSchema).default({}),
    errorDetails: z.record(z.string(), ErrorDetailSchema).default({}),
    connections: z.record(z.string(), ConnectionStateSchema).default({}),
    findings: z.record(z.string(), z.array(FindingSchema)).default({}),
});
export type State = z.infer<typeof StateSchema>;

export const freshState = (): State => ({
    hookToken: randomBytes(24).toString(`base64url`),
    resolved: {},
    snoozed: {},
    claims: {},
    ownerSteps: {},
    woken: {},
    seen: {},
    healthDetails: {},
    errorDetails: {},
    connections: {},
    findings: {},
});

export type StateDocument = ServerDocument<State>;

export const STATE_FILE = `state.json`;

export const stateOptions = {
    parse: (raw: Parameters<typeof StateSchema.safeParse>[0]): State | undefined => {
        const parsed = StateSchema.safeParse(raw);
        return parsed.success ? parsed.data : undefined;
    },
    fallback: freshState,
};

// Drops what no longer names anything: a finding gone for a month, details of issues no longer listed, snoozes past.
const GONE_FOR_MS = 30 * 24 * 60 * 60_000;
export const pruned = (state: State, now: number): State => {
    const live = new Set(Object.values(state.findings).flatMap((findings) => findings.map((finding) => finding.id)));
    const keep = <T>(record: Readonly<Record<string, T>>, keepIt: (key: string, value: T) => boolean): Record<string, T> =>
        Object.fromEntries(Object.entries(record).filter(([key, value]) => keepIt(key, value)));
    return {
        ...state,
        seen: keep(state.seen, (key, at) => live.has(key) || now - at < GONE_FOR_MS),
        snoozed: keep(state.snoozed, (_key, until) => until > now),
        resolved: keep(state.resolved, (key, at) => live.has(key) || now - at < GONE_FOR_MS),
        woken: keep(state.woken, (key) => live.has(key)),
        healthDetails: keep(state.healthDetails, (_key, detail) => now - detail.at < GONE_FOR_MS),
        errorDetails: keep(state.errorDetails, (_key, detail) => now - detail.at < GONE_FOR_MS),
    };
};
