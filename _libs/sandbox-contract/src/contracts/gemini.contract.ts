import { oc } from "@orpc/contract";
import { ModelsSchema } from "../schemas.js";

// Gemini (Google) has no sandbox-owned credential of its own: Google publishes no Anthropic-protocol endpoint,
// so a Gemini turn always runs UNDER the Claude Code harness through the bundled translator, on the user's
// Google account (see translator.contract.ts for the connect handshake). That makes the model catalog for the
// picker the only Gemini-specific route — the same shape Codex has, for the same reason.
export const geminiContract = {
    // Gemini's live models for the model picker — the source of valid ids (see gemini-models.ts).
    models: oc.route({ method: "GET", path: "/gemini/models" }).output(ModelsSchema),
};
