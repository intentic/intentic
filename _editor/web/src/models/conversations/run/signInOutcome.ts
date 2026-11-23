import { sandboxRef } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { KeyedProvider } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { providerReady } from "../../providers/access";
import { keysBeside } from "../../providers/providerCatalog";
import { translatorAccounts } from "../../providers/providerAccounts";
import { error } from "../accounts/useChat-accounts";
import { useNotifications } from "../../../workbench/notifications/notifications";

// HOW A SIGN-IN ENDED, as the two records every surface that reports one reads (the chat's strip, Sandbox ▸ Models, the
// toast a landing raises off that page): the last one that failed, and the last one that connected an account. Kept apart
// from the handshake itself (useChat-connect.ts), which writes them and is read through useChat like them.

// The last sign-in that ended without connecting anything, and the sentence saying why: what the chat's strip and the
// connect view show until the reader tries again or dismisses it. Without it a sign-in that expired, was refused or
// never started simply vanished, and the reader was left with a tile that looked picked and nothing else.
// `connectedBefore` is whether the provider could already run when it failed (a second account that did not land).
// `kind` is how it ended, as this store knows it rather than as a provider's sentence words it, so the card can lead with
// the fix that matches: `expired` (nobody finished in time: start again), `unstarted` (the sandbox never produced a
// sign-in: try again, likely a sandbox matter), `refused` (the provider or the sandbox turned the sign-in down, its own
// sentence in `message`).
export type SignInFailureKind = `expired` | `unstarted` | `refused`;
export const signInFailure = sandboxRef<
    { readonly provider: AgentProvider; readonly message: string; readonly kind: SignInFailureKind; readonly connectedBefore?: boolean } | undefined
>(() => undefined);

// Whether a provider can run by any credential filed under it: its own accounts, or a vendor's API key on its card.
const connectedAtAll = (provider: AgentProvider): boolean => providerReady(provider) || keysBeside(provider).some((key) => providerReady(key.id));

// Ends an attempt as failed: `error` for the surfaces that read the store's one error line, the record for the ones that
// say which provider it was.
export const failSignIn = (provider: AgentProvider, message: string, kind: SignInFailureKind): void => {
    error.value = message;
    signInFailure.value = { provider, message, kind, connectedBefore: connectedAtAll(provider) };
};

// A failure says a provider did not connect. Once it has connected another way (the API key on the same card, a sign-in
// finished in another window), the failure no longer says anything true and goes by itself. Kept, it stood over a chat
// and a card that could both run, and its Try again sent a reader back through the sign-in that had failed, for half an
// hour (session replay, 2026-11-16). A provider that could already run when it failed keeps its failure until dismissed.
watch(
    () => {
        const failure = signInFailure.value;
        return failure !== undefined && failure.connectedBefore !== true && connectedAtAll(failure.provider);
    },
    (connected) => {
        if (connected) {
            signInFailure.value = undefined;
        }
    },
);

export const dismissSignInFailure = (): void => {
    signInFailure.value = undefined;
};

// Whether this attempt sent the reader to the provider's page at all, kept past the attempt's own state (which a landing
// clears first), so the panel that says it connected can also say the provider's tab is now free to close.
// allow(module-state): one sign-in at a time per window, as the handshake it describes.
let tripped = false;
export const markTrip = (): void => {
    tripped = true;
};
export const resetTrip = (): void => {
    tripped = false;
};

// What the path that saw an account land knows about it: `who` signed in (a pasted code's answer, a watched attempt's
// record, the row that appeared), and whether that was an account already here signing in again (`refreshed`), which
// replaced its credential rather than adding a row.
export interface SignInArrival {
    readonly who?: string | undefined;
    readonly refreshed?: boolean | undefined;
}

// The last sign-in that connected an account, stamped so a second landing of the same provider still reads as news. Said
// by the paths that saw an account arrive, never inferred from a panel going away: a Cancel pressed in the chat's strip
// takes the panel down too, and a view that read that as success announced a connection nobody made. `tab` is whether the
// reader went to the provider's page for it.
export interface SignInLanding {
    readonly provider: AgentProvider;
    readonly at: number;
    readonly who?: string;
    readonly refreshed: boolean;
    readonly tab: boolean;
}
export const signInLanded = sandboxRef<SignInLanding | undefined>(() => undefined);

// How many Sandbox ▸ Models views are on screen in this window. While one is, it owns every sign-in: it says a landing in
// its own panel, and the chat's strip stands down rather than repeating beside it what the panel already shows. With none,
// a landing is said as a receipt wherever the reader is: a sign-in finished on a machine of theirs, or in another tab,
// while they were reading a chat, connected something they would otherwise not hear of.
// allow(module-state): a count of this window's own views, not about a sandbox.
const modelsViews = ref(0);
export const modelsOnScreen = computed(() => modelsViews.value > 0);
export const holdModelsView = (): (() => void) => {
    modelsViews.value += 1;
    let held = true;
    return (): void => {
        if (held) {
            held = false;
            modelsViews.value -= 1;
        }
    };
};

export const landSignIn = (provider: AgentProvider, arrival: SignInArrival = {}): void => {
    const landing = { provider, at: Date.now(), refreshed: arrival.refreshed === true, tab: tripped } satisfies SignInLanding;
    signInLanded.value = arrival.who === undefined || arrival.who === `` ? landing : { ...landing, who: arrival.who };
    if (!modelsOnScreen.value) {
        const name = providerSpec(provider)?.accountLabel ?? providerLabel(provider);
        const title = landing.refreshed ? t(`connect.landed.refreshedTitle`, { provider: name }) : t(`connect.landed.title`, { provider: name });
        useNotifications().report(arrival.who === undefined || arrival.who === `` ? { tone: `done`, title } : { tone: `done`, title, detail: arrival.who });
    }
};

// Who a provider's own account is, as a reader would recognise it: the address it signs in as, else its name here.
export const accountArrival = (account: OauthAccount, before: ReadonlyMap<string, number>): SignInArrival => ({
    who: account.email ?? account.label,
    refreshed: before.has(account.id),
});

// Who a subscription sign-in brought in, read off the translator's list against the names it held when the sign-in
// started: a name it did not hold is a new subscription, and with none new, the one sign-in replaced in place.
export const translatorArrival = (target: KeyedProvider, before: ReadonlySet<string>): SignInArrival => {
    const now = translatorAccounts.value[target] ?? [];
    const added = now.find((account) => !before.has(account.name));
    if (added !== undefined) {
        return { who: added.label, refreshed: false };
    }
    return { refreshed: now.length > 0 };
};
