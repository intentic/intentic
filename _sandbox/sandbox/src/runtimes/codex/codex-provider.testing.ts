import { WORKSPACE_ROOT } from "@intentic/constants";
import { stateRelPath } from "../../state-paths.js";
import type { CodexSlice } from "./codex-provider.js";

// Codex's slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const codexSliceFake = () =>
    ({
        codexHome: `${WORKSPACE_ROOT}/${stateRelPath(".intentic/secrets/auth/", "codex")}`,
        codexThreadExists: async () => true,
        // Held directly too: the native Codex turn's resolution and self-heal both read this, not the provider table.
        codexModels: { models: async () => ({ models: [{ id: "gpt-5.1", label: "GPT 5.1" }], default: "gpt-5.1" }), record: async () => {} },
        async *codexAgent() {
            yield { kind: "done" };
        },
    }) satisfies CodexSlice;
