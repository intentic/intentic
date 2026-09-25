import { signJwt } from "./jwt.js";

// The document server's command service, for the one command used here: a forced save of a live session. The viewer
// asks for one when it keeps an editor alive out of sight, so what was typed reaches the workspace now, not whenever
// that editor finally closes.

// The service's own `error` codes: 0 the save started (its callback follows), 4 nothing changed since the last save, 1
// no session holds the key.
export type ForceSaveOutcome = "started" | "unchanged" | "no-session" | "refused";

const COMMAND_TIMEOUT_MS = 10_000;

export const outcomeOf = (error: unknown): ForceSaveOutcome => {
    switch (error) {
        case 0:
            return "started";
        case 4:
            return "unchanged";
        case 1:
            return "no-session";
        default:
            return "refused";
    }
};

// Signed in the body, the form the service reads first.
export const forceSave = async (port: number, key: string, secret: string): Promise<ForceSaveOutcome> => {
    const command = { c: "forcesave", key };
    const response = await fetch(`http://127.0.0.1:${port}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, token: signJwt(command, secret) }),
        signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    });
    if (!response.ok) {
        return "refused";
    }
    const answer = (await response.json()) as { readonly error?: unknown };
    return outcomeOf(answer.error);
};
