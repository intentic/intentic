import { asZone, UTC, type Zone } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";

// WHICH CLOCK A CRON IS READ ON. The daemon's container runs UTC and the person who typed "20:43" almost never does,
// so every croner call in this tree goes through one of these two rather than letting the process's own zone answer by
// default — which is what it does for a bare `new Cron(expr)`, silently, with a plausible-looking result.

/**
 * The sandbox's zone of record. UTC when nobody has set one, which is a real answer rather than a guess: a sandbox
 * whose owner has never said where they are has no better information, and every screen that shows a schedule says
 * which clock it is on, so the owner can see the assumption instead of discovering it two hours late.
 */
export const sandboxZone = async (services: Pick<Services, "sandboxSettings">): Promise<Zone> => asZone((await services.sandboxSettings.get()).timezone) ?? UTC;

/**
 * The clock one automation's cron is meant on: its own override first, the sandbox's setting behind it. An id the
 * schema let through but ICU no longer knows (a zone retired between two releases) falls back rather than throwing —
 * an automation with a stale zone should fire an hour out, not take the tick down with it.
 */
export const zoneOf = (trigger: { readonly tz?: string | undefined }, sandbox: Zone): Zone => asZone(trigger.tz) ?? sandbox;
