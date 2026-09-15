import { z } from "zod";
// What speed a turn is actually being served at. `cooldown` is its own state rather than a flavour of `off`
// because it is the only one that lifts by itself: fast mode draws on a rate-limit pool separate from the
// model's, and a turn that exhausts it drops to standard speed and stays there until the pool reopens. The
// distinction is what lets the client say "not right now" instead of "not available", which are different
// answers to "why am I not getting what I asked for". Mirrors the harness's own vocabulary (SDK: FastModeState).
export const FastModeStateSchema = z.enum(["off", "cooldown", "on"]);
export type FastModeState = z.infer<typeof FastModeStateSchema>;
