import type { IntenticOsWifiList, IntenticOsWifiNetwork } from "@intentic/sandbox-contract/schemas/intentic-os";
import { example, GOLDEN } from "./golden.testing";
import { asksPassword, joinSaidOf, networksShown, onlineOf, strengthOf } from "./networkCard";

// The network as the card reads it: how this computer is online, the networks in the order a person looks for theirs,
// which asks for a password before the first join, and what a join came to. The answers are the contract's own examples
// of what `ic os network` prints (golden/intentic-os.json).

const network = (fields: Partial<IntenticOsWifiNetwork>): IntenticOsWifiNetwork => ({ ssid: `Net`, signal: 50, secured: true, known: false, active: false, ...fields });

describe(`how this computer is online`, () => {
    it(`is the Wi-Fi network by its name and its strength, a cable, or nothing`, () => {
        expect(onlineOf(example(GOLDEN.networkStatus, 0))).toEqual({ kind: `wifi`, name: `Home Fiber`, strength: 3 });
        // NetworkManager's name for a wired connection says nothing a person needs.
        expect(onlineOf(example(GOLDEN.networkStatus, 1))).toEqual({ kind: `wired` });
        expect(onlineOf(example(GOLDEN.networkStatus, 2))).toEqual({ kind: `offline` });
        expect(onlineOf({ connected: false, kind: `wifi`, name: `Home`, signal: 80 })).toEqual({ kind: `offline` });
        expect(onlineOf({ connected: true, kind: `wifi`, name: null, signal: null })).toEqual({ kind: `wifi`, name: undefined, strength: undefined });
    });

    it(`draws a signal in four steps`, () => {
        expect([0, 24, 25, 49, 50, 74, 75, 100].map(strengthOf)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    });
});

describe(`the networks in reach`, () => {
    it(`list the one in use first, then those joined before, then the rest, each strongest first`, () => {
        expect(networksShown(example(GOLDEN.wifiList)).map((each) => each.ssid)).toEqual([`Home Fiber`, `Office`, `Café: Guest`, `Neighbours 5G`]);
        const shuffled: IntenticOsWifiList = {
            adapter: true,
            enabled: true,
            networks: [
                network({ ssid: `weak`, signal: 20 }),
                network({ ssid: `known weak`, signal: 10, known: true }),
                network({ ssid: `strong`, signal: 90 }),
                network({ ssid: ``, signal: 99 }),
                network({ ssid: `in use`, signal: 5, active: true, known: true }),
            ],
        };
        // A hidden network has no name to pick it by.
        expect(networksShown(shuffled).map((each) => each.ssid)).toEqual([`in use`, `known weak`, `strong`, `weak`]);
        // The list it was given is left as it was.
        expect(shuffled.networks[0]?.ssid).toBe(`weak`);
    });

    it(`ask for a password first only where it is locked and this computer has not joined it before`, () => {
        expect(asksPassword(network({ secured: true }))).toBe(true);
        expect(asksPassword(network({ secured: false }))).toBe(false);
        expect(asksPassword(network({ secured: true, known: true }))).toBe(false);
        expect(asksPassword(network({ secured: true, active: true }))).toBe(false);
    });
});

describe(`a join`, () => {
    it(`is done, asks for the password (again, after a wrong one), or says why not`, () => {
        expect(joinSaidOf({ outcome: `joined`, reason: null })).toEqual({ kind: `joined` });
        expect(joinSaidOf({ outcome: `needsPassword`, reason: null })).toEqual({ kind: `ask`, wrong: false });
        expect(joinSaidOf({ outcome: `wrongPassword`, reason: null })).toEqual({ kind: `ask`, wrong: true });
        expect(joinSaidOf({ outcome: `notOs`, reason: null })).toEqual({ kind: `notOs` });
        expect(joinSaidOf({ outcome: `failed`, reason: `no network called Office in reach` })).toEqual({ kind: `failed`, reason: `no network called Office in reach` });
        expect(joinSaidOf({ outcome: `failed`, reason: null })).toEqual({ kind: `failed`, reason: undefined });
    });
});
