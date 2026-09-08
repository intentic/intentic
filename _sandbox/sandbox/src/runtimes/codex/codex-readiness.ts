import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { connectedTranslatorProviders, TRANSLATOR_BINARY_MISSING } from "../../agent/providers/translator.js";
import { onPath } from "../../platform/boot/on-path.js";
import { CODEX_BINARY_MISSING, codexBinary } from "./codex-path.js";

// Single answer to whether Codex can serve a turn, read by both planCodexTurn's refusal and the health probe's tooltip.
// Distinguishes a subscription nobody connected from a translator pack that isn't installed, via the auth-dir on disk,
// not the Management API.

export type CodexReadiness =
    | {
          readonly ok: true;
          // True when the turn rides the translator's ChatGPT subscription; false means the container's OPENAI_API_KEY.
          readonly routed: boolean;
      }
    | {
          readonly ok: false;
          readonly detail: string;
          // Set only when connecting an account fixes the problem; never for a missing binary, which login can't solve.
          readonly code?: Extract<AgentEvent, { kind: "error" }>["code"];
      };

export const codexReadiness = async (services: Services): Promise<CodexReadiness> => {
    // Checked first: true for every credential path, and a core image carries the SDK but not the CLI it names.
    if ((await codexBinary()) === undefined) {
        return { ok: false, detail: CODEX_BINARY_MISSING };
    }
    if (services.config.translator.url === "") {
        return services.config.openaiApiKey !== ""
            ? { ok: true, routed: false }
            : {
                  ok: false,
                  code: "subscription-required",
                  detail: "This sandbox has no model translator, so Codex can't run here. Run a sandbox built from the published image.",
              };
    }
    if ((await services.cliProxy.accounts()).codex.length > 0) {
        return { ok: true, routed: true };
    }
    if (services.config.openaiApiKey !== "") {
        return { ok: true, routed: false };
    }
    // No account here means nobody connected one, or the translator can't run; the auth-dir tells them apart.
    if ((await connectedTranslatorProviders(services.authRoot)).has("codex") && !(await onPath("cli-proxy-api"))) {
        return { ok: false, detail: TRANSLATOR_BINARY_MISSING };
    }
    return { ok: false, code: "subscription-required", detail: "Connect your ChatGPT subscription in Sandbox ▸ Agent to run Codex." };
};
