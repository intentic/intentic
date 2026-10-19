import type { PasswordRequest, PasswordsEvent } from "@intentic/ext-passwords/app";
import { keyringApp } from "./keyringCommands";

/* WHAT HAPPENS WITHOUT ASKING, for the Passwords app on this computer (tauriPort.ts `subscribe`): the keyring's record and
   its waiting requests read every 5 s while the window is on screen. A capture since the last read is a toast, a request
   not seen before is a request, anything else a change. */

const POLL_MS = 5000;

export interface PollSources {
    readonly requests: () => Promise<readonly PasswordRequest[]>;
    // A password's title as the list last read it, for the toast's words.
    readonly titleOf: (name: string) => string | undefined;
}

export const pollPasswordEvents = (listener: (event: PasswordsEvent) => void, { requests, titleOf }: PollSources): (() => void) => {
    let since = Date.now();
    const seenNeeds = new Set<string>();
    let first = true;
    const told = (requestsNow: readonly PasswordRequest[]): void => {
        for (const request of requestsNow) {
            if (!seenNeeds.has(request.id)) {
                seenNeeds.add(request.id);
                // The ones already waiting when the app opened are in its list; only a new one is news.
                if (!first) {
                    listener({ kind: `request`, request });
                }
            }
        }
    };
    const tick = async (): Promise<void> => {
        if (document.visibilityState !== `visible`) {
            return;
        }
        try {
            const [{ lines }, waiting] = await Promise.all([keyringApp(`activity`, { limit: 50 }), requests()]);
            const fresh = lines.filter((line) => line.at > since);
            since = Math.max(since, ...lines.map((line) => line.at));
            for (const line of fresh) {
                if (line.op === `capture` && (line.outcome === `saved` || line.outcome === `updated`) && line.secret !== undefined) {
                    listener({ kind: `captured`, outcome: line.outcome, name: line.secret, title: titleOf(line.secret) ?? line.target ?? line.secret, via: line.program ?? line.target ?? ``, at: line.at });
                }
            }
            told(waiting);
            if (fresh.length > 0 && !fresh.some((line) => line.op === `capture`)) {
                listener({ kind: `changed` });
            }
            first = false;
        } catch {
            // allow(silent-catch): a locked or absent keyring answers nothing new; the next tick asks again
        }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    const onVisible = (): void => void tick();
    document.addEventListener(`visibilitychange`, onVisible);
    void tick();
    return () => {
        clearInterval(timer);
        document.removeEventListener(`visibilitychange`, onVisible);
    };
};
