import { capabilitiesOf, withRuntimeDefaults } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { JournalledTurn } from "./turn-journal.js";

// A turn a restart cut never settled, so it never wrote its ledger row: the turns ledger (diagnostics `turns`) showed
// nothing minutes after a restart had cut every running session (2026-10-11). The boot pass that finds it in the
// journal writes the row for it, once it has decided what becomes of the turn: re-run, left on the record, given up.
// Filed as `cancelled` with the code `interrupted`, since a restart is not the provider failing: a run role's health
// (role-model-health.ts) reads an `error` row as the provider's.

// The code a restart's row carries, which a reader filters on.
export const INTERRUPTED_CODE = "interrupted";

/**
 * Appends the ledger row of a journalled turn a restart cut, saying what became of it. Fire-and-forget: a row that
 * cannot be written costs the ledger one line, never the boot.
 */
export const recordInterrupted = (services: Pick<Services, "usage" | "logger">, entry: JournalledTurn, fate: string, now: number): void => {
    const turn = withRuntimeDefaults(entry.turn);
    const sessionId = entry.sessionId ?? entry.turn.sessionId;
    const row = {
        provider: turn.agent,
        harness: turn.harness,
        runtime: capabilitiesOf(turn.agent, turn.harness).runtime,
        ...opt("account", turn.account),
        // What was asked for: what actually ran is not on the journal.
        ...(turn.model !== undefined && turn.model !== "" ? { modelRequested: turn.model } : {}),
        outcome: "cancelled" as const,
        errorCode: INTERRUPTED_CODE,
        errorMessage: `cut by a daemon restart; ${fate}`,
        conversationId: turn.conversationId,
        ...opt("run", entry.run?.id),
        ...opt("sessionId", sessionId),
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        // From its start to this boot: when the daemon died is written nowhere, so the downtime is in it too.
        durationMs: Math.max(0, now - entry.startedAt),
    };
    void Promise.resolve()
        .then(() => services.usage.record(row))
        .catch((error: unknown) =>
            services.logger.warn({ err: error, conversationId: turn.conversationId }, "usage: the ledger row of a turn the restart cut could not be appended"),
        );
};
