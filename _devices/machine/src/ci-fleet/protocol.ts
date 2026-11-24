import {
    CI_RUNNER_LOG_TAIL_MAX,
    CiCacheSchema,
    CiFleetPassSchema,
    CiRunnerNameSchema,
    CiRunnerOpSchema,
    CiRunnerRegisterArgsSchema,
    CiRunnerRemoveArgsSchema,
    CiSlotsSchema,
} from "@intentic/sandbox-contract/schemas/ci-fleet";
import { z } from "zod";

/* WHAT THE PERSON'S AGENT MAY ASK THE FLEET SERVICE, over /run/intentic-ci/fleet.sock: one JSON line in, one JSON line
   out, then the connection closes. A closed list: every verb is something the board or a device tool does, and each
   carries only names and numbers the service checks again (a unit is one of the runner units it discovered; a
   registration's token is GitHub's to judge). Anything the schema does not read is refused unread. */

export const FleetRequestSchema = z.discriminatedUnion("verb", [
    // The service's own state: its version, the last pass of each round, the cache sizes and the slot pool.
    z.object({ verb: z.literal("status") }).strict(),
    // The agent's version, said on each status read: the service follows it, through a signed release only.
    z.object({ verb: z.literal("hello"), version: z.string().regex(/^\d+\.\d+\.\d+$/u) }).strict(),
    z.object({ verb: z.literal("unit"), name: CiRunnerNameSchema, op: CiRunnerOpSchema }).strict(),
    z.object({ verb: z.literal("logs"), name: CiRunnerNameSchema, tail: z.number().int().positive().max(CI_RUNNER_LOG_TAIL_MAX) }).strict(),
    z.object({ verb: z.literal("janitor"), dryRun: z.boolean() }).strict(),
    z.object({ verb: z.literal("prune"), dryRun: z.boolean() }).strict(),
    z.object({ verb: z.literal("register"), args: CiRunnerRegisterArgsSchema }).strict(),
    z.object({ verb: z.literal("deregister"), args: CiRunnerRemoveArgsSchema }).strict(),
]);
export type FleetRequest = z.infer<typeof FleetRequestSchema>;

// What the service keeps of its rounds and answers `status` with (and writes, world-readable, to status.json).
export const FleetStatusSchema = z.object({
    version: z.string(),
    startedAt: z.string(),
    keeper: CiFleetPassSchema.optional(),
    janitor: CiFleetPassSchema.optional(),
    prune: CiFleetPassSchema.optional(),
    caches: z.array(CiCacheSchema).default([]),
    slots: CiSlotsSchema.optional(),
});
export type FleetStatus = z.infer<typeof FleetStatusSchema>;

// Every answer: `ok` with what the verb returns, or the reason it was refused, in words.
export const FleetAnswerSchema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), status: FleetStatusSchema.optional(), said: z.string().optional(), text: z.string().optional(), pass: CiFleetPassSchema.optional() }),
    z.object({ ok: z.literal(false), error: z.string() }),
]);
export type FleetAnswer = z.infer<typeof FleetAnswerSchema>;

// The most one request line may be: a registration is the longest, a few hundred bytes.
export const MAX_REQUEST_BYTES = 16 * 1024;
