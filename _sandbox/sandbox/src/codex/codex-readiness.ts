import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { connectedTranslatorProviders, TRANSLATOR_BINARY_MISSING } from "../agent/translator.js";
import { onPath } from "../platform/on-path.js";
import { CODEX_BINARY_MISSING, codexBinary } from "./codex-path.js";

/* CAN CODEX SERVE A TURN HERE, and if not, which of the reasons is it — asked in one place because two callers
 * need the same answer at different moments: planCodexTurn as the turn's refusal, and the codex adapter's
 * health probe as the picker's greyed-out tooltip. They used to gate on separately-written copies of the same
 * condition, with two nearly-identical message strings behind them.
 *
 * A SPLIT IMAGE ADDED A REASON THAT LOOKS EXACTLY LIKE THE OLD ONE, which is what makes this worth unifying.
 * "No Codex account" was previously read straight off the translator's Management API — but that API is the
 * translator, and on a core image the translator is a pack that isn't installed. So a user who HAS connected
 * their ChatGPT subscription got told to go and connect it, with the button they'd already pressed, and no
 * mention of the rebuild that was actually missing. The auth-dir on disk is what tells the two apart. */

export type CodexReadiness =
    | {
          readonly ok: true;
          // The turn rides the translator's ChatGPT subscription; false ⇒ the container's OPENAI_API_KEY.
          readonly routed: boolean;
      }
    | {
          readonly ok: false;
          readonly detail: string;
          // Set only where connecting an account is what fixes it — it is what puts the connect gate in front of
          // the user. A missing binary is not that, and offering a sign-in for it would be a dead end.
          readonly code?: Extract<AgentEvent, { kind: "error" }>["code"];
      };

export const codexReadiness = async (services: Services): Promise<CodexReadiness> => {
    // First, because it is true of every credential: whatever authenticates the turn, the turn is `codex exec`,
    // and a core image carries the SDK but not the CLI it drives.
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
    // The Management API named no Codex account — which is a subscription nobody connected, or a translator that
    // cannot run to be asked. Only the first is the user's to fix by signing in, and the auth-dir separates them.
    if ((await connectedTranslatorProviders(services.authRoot)).has("codex") && !(await onPath("cli-proxy-api"))) {
        return { ok: false, detail: TRANSLATOR_BINARY_MISSING };
    }
    return { ok: false, code: "subscription-required", detail: "Connect your ChatGPT subscription in Sandbox ▸ Agent to run Codex." };
};
