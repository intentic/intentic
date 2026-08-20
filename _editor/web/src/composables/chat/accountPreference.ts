import type { AgentProvider } from "@intentic/sandbox-contract";
import { perProvider } from "./providerCatalog";

/* Which account of each provider the user last picked for a turn, per sandbox, what a new conversation's
 * account selection seeds from, and what a reloaded window comes back wearing. Without it the pick lived in
 * memory only, so every refresh resolved the selection to "the provider's first account" and silently undid a
 * choice the user had made deliberately (headroom left on one account, a different organization on another).
 *
 * SANDBOX-SCOPED, because an account id is not a global name: it is the key of a credential file in one
 * sandbox's own store (<workspace>/.intentic/<provider>/<id>.json), so carrying it to another sandbox would pin
 * a chat to an account that does not exist there. The tab snapshot is keyed this way for the same reason.
 *
 * localStorage, and one store rather than tabSnapshot's two: this is a PREFERENCE, not a window's own state, so
 * the last pick made anywhere is the one the next window opens on, the same last-writer-wins the other turn
 * prefs (turnDefaults) have. What a window is CURRENTLY showing never comes from here; `selectedAccountId` holds
 * that in memory, and this is read only when a window binds to a sandbox.
 *
 * A pick is remembered whether or not the account still exists, because only the daemon's account list can say,
 * so validating it belongs to the reader (rememberedAccountFor) and to the moment that list lands
 * (refreshAccounts), not here. */

const key = (sandboxId: string): string => `intentic.chatAccounts.${sandboxId}`;

// The last pick per provider, or a blank slate, for an unbound sandbox, an unreadable blob, or storage that
// isn't there at all (private mode, where merely touching it throws).
export const readAccountPreference = (sandboxId: string | undefined): Record<AgentProvider, string | undefined> => {
    const blank = perProvider<string | undefined>(() => undefined);
    if (sandboxId === undefined) {
        return blank;
    }
    try {
        const raw = localStorage.getItem(key(sandboxId));
        if (raw === null) {
            return blank;
        }
        const stored = JSON.parse(raw) as Record<string, unknown>;
        // Any provider is a candidate key, the vocabulary is open (native ids plus installed ACP agents), and a
        // value is usable only as a non-empty id. Anything else is dropped to the blank slate's `undefined`,
        // which every reader already handles as "no pick yet".
        const picks = Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === `string` && entry[1] !== ``);
        return { ...blank, ...Object.fromEntries(picks) };
    } catch {
        return blank;
    }
};

// Persist the picks. Providers with none drop out (JSON.stringify omits undefined), which is exactly how the
// reader takes them back.
export const writeAccountPreference = (sandboxId: string, picks: Record<AgentProvider, string | undefined>): void => {
    try {
        localStorage.setItem(key(sandboxId), JSON.stringify(picks));
    } catch {
        // Unavailable or over quota; the in-memory selection still holds for the life of the window.
    }
};
