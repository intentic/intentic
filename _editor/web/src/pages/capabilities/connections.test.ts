import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { CapabilityStatus } from "@intentic-app/api-contract";
import type { VpnLink } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { awaitingLogin, connectionFacts, connectionState, rebuildStep, vpnFacts } from "./connections";

/* The reader's question is not what the daemon calls a state but whether they still have something to do, and
 * for two kinds the status field is not the truest answer available. Both surfaces that list connections read
 * through here, so an account cannot be "needs sign-in" in the inventory and "pending" on its own card. */

const instance = (status: CapabilityStatus, config: Record<string, string> = {}): CapabilitySummary =>
    ({ id: `reddit`, kind: `browser`, status, config }) as CapabilitySummary;

// The daemon's wording is what tells the two pending browsers apart, and they lead to opposite places: a login
// window right here, or a rebuild on another screen.
test(`tells a browser waiting on a login from one waiting on a rebuild`, () => {
    const login = instance({ state: `pending`, detail: `log in to connect your account` });
    const build = instance({ state: `pending`, detail: `rebuild the sandbox to install the browser` });

    expect(awaitingLogin(login)).toBe(true);
    expect(awaitingLogin(build)).toBe(false);

    expect(connectionState(`browser`, login, undefined).label).toBe(`needs sign-in`);
    expect(connectionState(`browser`, build, undefined).label).toBe(`needs setup`);

    // Only the rebuild one gets a link, and a machine never does: its remedy is a button on its own row.
    expect(rebuildStep(`browser`, build)).toBe(true);
    expect(rebuildStep(`browser`, login)).toBe(false);
    expect(rebuildStep(`host`, build)).toBe(false);
});

/* A machine that is simply asleep is not a machine with something to do, and no stored status can say which it
 * is: only the roster can. */
test(`reads a connected machine's liveness from the roster rather than its status`, () => {
    const machine = instance({ state: `active` });

    expect(connectionState(`host`, machine, true).label).toBe(`online`);
    expect(connectionState(`host`, machine, false).label).toBe(`offline`);
    // Not yet in the roster reads as offline, not as an error.
    expect(connectionState(`host`, machine, undefined).label).toBe(`offline`);
});

// Rank is the same judgement as the wording: a list that mostly works still opens on the part that doesn't.
test(`sorts what is unfinished or broken above what merely works`, () => {
    const rank = (state: CapabilityStatus[`state`]): number => connectionState(`mcp`, instance({ state }), undefined).rank;

    expect(rank(`error`)).toBeLessThan(rank(`pending`));
    expect(rank(`pending`)).toBeLessThan(rank(`inactive`));
    expect(rank(`inactive`)).toBeLessThan(rank(`active`));
    expect(connectionState(`mcp`, instance({ state: `active` }), undefined).label).toBe(`ready`);
});

/* Two facts at most, in the order somebody would say them. A third is what pushes the state badge off the end of
 * the line, and `provider`/`platform` are deliberately not among them: they are the card, which the row already
 * names, so printing one would spend the line on "github · github". */
test(`names a connection by what tells it apart, two facts at most`, () => {
    expect(connectionFacts(instance({ state: `active` }, { host: `ops.acme.dev`, user: `ada`, database: `shop`, platform: `reddit` }))).toBe(
        `ops.acme.dev · shop`,
    );
    expect(connectionFacts(instance({ state: `active` }, { platform: `reddit` }))).toBe(``);
    expect(connectionFacts(instance({ state: `active` }, { host: `  ` }))).toBe(``);
    // An account filed under an identity: the card names the site, so who it belongs to and what it is for are
    // the whole line, and the date it was opened never takes a slot from either.
    expect(
        connectionFacts(
            instance({ state: `active` }, { platform: `reddit`, identity: `radarsuspam2`, purpose: `community research`, openedAt: `2026-08-11` }),
        ),
    ).toBe(`radarsuspam2 · community research`);
});

/* A tunnel's address and what it routes are read off the live link, never off the stored config, and a tunnel
 * that is down says nothing here, because the row's own status already says it. */
test(`reports a tunnel's live address only while it is up`, () => {
    const link = (overrides: Partial<VpnLink>): VpnLink => ({ id: `hq`, state: `connected`, routes: [], ...overrides }) as VpnLink;

    expect(vpnFacts(`hq`, [link({ address: `10.8.0.4`, routes: [`10.0.0.0/8`, `192.168.1.0/24`] })])).toBe(`10.8.0.4 · 10.0.0.0/8, 192.168.1.0/24`);
    // A default route is the one worth naming in words: "all traffic" is what the user actually asked for.
    expect(vpnFacts(`hq`, [link({ address: `10.8.0.4`, routes: [`0.0.0.0/0`] })])).toBe(`10.8.0.4 · all traffic`);
    expect(vpnFacts(`hq`, [link({ state: `disconnected`, address: `10.8.0.4` })])).toBeUndefined();
    expect(vpnFacts(`hq`, [])).toBeUndefined();
});
