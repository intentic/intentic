import type { IntenticOsNetworkStatus, IntenticOsWifiList, IntenticOsWifiNetwork } from "@intentic/sandbox-contract/schemas/intentic-os";
import type { OsWifiJoin } from "../../osSettings";

// THE NETWORK, READ (src-tauri/src/os_settings.rs runs `ic os network`, settings.ts holds it, NetworkCard.vue draws it):
// how this computer is online, the Wi-Fi networks in reach in the order a person looks for theirs, which of them asks for
// a password before joining, and what a join came to. Pure, so each case is tested by value (networkCard.test.ts).

/** How strong a signal is, in the four steps the bars draw. */
export type Strength = 1 | 2 | 3 | 4;

export const strengthOf = (signal: number): Strength => {
    if (signal >= 75) {
        return 4;
    }
    if (signal >= 50) {
        return 3;
    }
    return signal >= 25 ? 2 : 1;
};

/** How this computer is online, as the card's first line says it. A cable's connection is NetworkManager's own name
 *  ("Wired connection 1"), which says nothing a person needs, so it is not repeated. */
export type Online =
    | { readonly kind: `wifi`; readonly name: string | undefined; readonly strength: Strength | undefined }
    | { readonly kind: `wired` }
    | { readonly kind: `offline` };

export const onlineOf = (status: IntenticOsNetworkStatus): Online => {
    if (!status.connected || status.kind === `none`) {
        return { kind: `offline` };
    }
    if (status.kind === `ethernet`) {
        return { kind: `wired` };
    }
    return { kind: `wifi`, name: status.name ?? undefined, strength: status.signal === null ? undefined : strengthOf(status.signal) };
};

// The one in use, then those this computer has joined before, then the rest.
const rankOf = (network: IntenticOsWifiNetwork): number => {
    if (network.active) {
        return 0;
    }
    return network.known ? 1 : 2;
};

/** The networks the card lists: the one in use first, then those joined before, then the rest, each strongest first. A
 *  hidden network broadcasts no name, and cannot be picked by one. */
export const networksShown = (list: IntenticOsWifiList): readonly IntenticOsWifiNetwork[] =>
    list.networks.filter((network) => network.ssid !== ``).sort((one, other) => rankOf(one) - rankOf(other) || other.signal - one.signal);

/** A network that asks for its password before the first join: locked, and not one this computer already knows. A
 *  known one rejoins by itself, and an open one needs none. */
export const asksPassword = (network: IntenticOsWifiNetwork): boolean => network.secured && !network.known && !network.active;

/** What the card says after a join: nothing more to say, the password field (again, after a wrong one), or why not. */
export type JoinSaid =
    | { readonly kind: `joined` }
    | { readonly kind: `ask`; readonly wrong: boolean }
    | { readonly kind: `failed`; readonly reason: string | undefined }
    | { readonly kind: `notOs` };

export const joinSaidOf = (join: OsWifiJoin): JoinSaid => {
    switch (join.outcome) {
        case `joined`:
            return { kind: `joined` };
        case `needsPassword`:
            return { kind: `ask`, wrong: false };
        case `wrongPassword`:
            return { kind: `ask`, wrong: true };
        case `notOs`:
            return { kind: `notOs` };
        default:
            return { kind: `failed`, reason: join.reason ?? undefined };
    }
};
