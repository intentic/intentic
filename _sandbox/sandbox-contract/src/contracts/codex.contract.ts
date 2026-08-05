import { oc } from "@orpc/contract";
import { ModelsSchema } from "../schemas.js";

// ChatGPT (Codex) has no sandbox-owned OAuth of its own: it authenticates through the bundled translator on the
// user's ChatGPT SUBSCRIPTION (see translator.contract.ts), so the only Codex-specific route is the model
// catalog for the picker.
export const codexContract = {
    // OpenAI/Codex's live models for the model picker — the source of valid ids (see codex-models.ts).
    models: oc.route({ method: "GET", path: "/codex/models" }).output(ModelsSchema),
};
