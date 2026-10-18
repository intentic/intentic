import type { HarnessRequest } from "../run/agent.js";
import type { TurnTaint } from "../../guard/turn-taint.js";
import { outsideResultHooks } from "../../guard/outside-results.js";
import { redactionHooks } from "./agent-redaction.js";

// Compose masking, cleaning and provenance in one callback; SDK hooks otherwise each read the original output.
export const toolResultHooks = (request: HarnessRequest, taint: TurnTaint) =>
    outsideResultHooks(
        (source) => {
            taint.mark(source);
        },
        request.tools.outputLogsDir === undefined
            ? undefined
            : {
                  logsDir: request.tools.outputLogsDir,
                  spec: request.tools.outputCleaners,
                  holdout: request.tools.outputHoldout,
                  conversationId: request.spec.conversationId,
              },
        request.tools.secrets === undefined ? undefined : redactionHooks(request.tools.secrets.list).PostToolUse?.[0]?.hooks[0],
    );
