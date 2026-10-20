import type { VpnLink } from "@intentic/sandbox-contract/schemas/vpn";
import type { CapabilitySummary, CapabilityStatus } from "@intentic/sandbox-contract/schemas/capabilities";
import { awaitingLogin, browserGrants, connectionFacts, connectionState, hostPresence, rebuildStep, vpnFacts } from "./connections";

// Reader's question is whether they still have something to do, not the daemon's state word, and for two kinds
// status alone isn't the truest answer. Both listing surfaces read through here, so an account can't be "needs
// sign-in" in the inventory and "pending" on its tile.

const instance = (status: CapabilityStatus, config: Record<string, string> = {}): CapabilitySummary =>
    ({ id: `reddit`, kind: `browser`, status, config }) as CapabilitySummary;

// Daemon's wording tells the two pending browsers apart, leading to opposite places: a login window here, or a
// rebuild elsewhere.
test(`tells a browser waiting on a login from one waiting on a rebuild`, () => {
    const login = instance({ state: `pending`, detail: `log in to connect your account` });
    const build = instance({ state: `pending`, detail: `rebuild the sandbox to install the browser` });

    expect(awaitingLogin(login)).toBe(true);
    expect(awaitingLogin(build)).toBe(false);

    expect(connectionState(`browser`, login).label).toBe(`needs sign-in`);
    expect(connectionState(`browser`, build).label).toBe(`needs setup`);

    // Only the rebuild one gets a link, and a machine never does: its remedy is a button on its own row.
    expect(rebuildStep(`browser`, build)).toBe(true);
    expect(rebuildStep(`browser`, login)).toBe(false);
    expect(rebuildStep(`device`, build)).toBe(false);
});

// A sleeping machine isn't a machine with something to do, and only the roster (not stored status) can tell which
// it is.
const pc = (windows: boolean, ...distros: readonly [string, boolean][]) =>
    hostPresence({ environments: [{ key: `native`, online: windows }, ...distros.map(([key, online]) => ({ key, online }))] });

test(`reads a connected machine's liveness from the roster rather than its status`, () => {
    const machine = instance({ state: `active` });

    expect(connectionState(`device`, machine, pc(true)).label).toBe(`online`);
    expect(connectionState(`device`, machine, pc(false)).label).toBe(`offline`);
    // Not yet in the roster reads as offline, not as an error.
    expect(connectionState(`device`, machine, hostPresence(undefined)).label).toBe(`offline`);
});

// (2026-10-13) lucid-arrow: rog's card read offline while the Devices page rebuilt through it. The roster decides
// whether a lent machine answers, whatever its stored status said when it was last read.
test(`reads a lent machine that answers as online, even under a status stored while it did not`, () => {
    const stale = instance({ state: `pending`, detail: `the device is offline` });
    expect(connectionState(`device`, stale, pc(true)).label).toBe(`online`);
    // Never paired, nothing answers: still the pairing it needs.
    expect(connectionState(`device`, instance({ state: `pending`, detail: `click Connect` }), pc(false)).label).toBe(`needs setup`);
});

// (2026-10-15) rog's Windows agent was gone for two days while its WSL distro stayed connected, and its card read as
// plain offline. A PC answering only through a distro is partly connected; one answering on Windows is online whatever
// its distros do, since a stopped test distro is the ordinary state of a PC.
test(`reads a PC answering only through a distro as partly connected, and one answering on Windows as online`, () => {
    const away = instance({ state: `pending`, detail: `the device is offline` });
    const partly = connectionState(`device`, away, pc(false, [`wsl:archlinux`, true]));
    expect(partly).toMatchObject({ label: `partly connected`, tone: `warning`, note: `its Windows side is offline; WSL archlinux still answers` });
    expect(connectionState(`device`, away, pc(false, [`wsl:ubuntu`, true], [`wsl:archlinux`, true])).note).toBe(
        `its Windows side is offline; WSL archlinux, ubuntu still answer`,
    );
    expect(connectionState(`device`, instance({ state: `active` }), pc(true, [`wsl:archlinux`, false])).label).toBe(`online`);
    // Nothing of it answers: as before.
    expect(connectionState(`device`, away, pc(false, [`wsl:archlinux`, false])).label).toBe(`needs setup`);
    // A card the owner switched off stays off, whatever is still connected.
    expect(connectionState(`device`, instance({ state: `inactive` }), pc(false, [`wsl:archlinux`, true])).label).toBe(`off`);
});

// Rank is the same judgement as the wording: a list that mostly works still opens on the part that doesn't.
test(`sorts what is unfinished or broken above what merely works`, () => {
    const rank = (state: CapabilityStatus[`state`]): number => connectionState(`mcp`, instance({ state })).rank;

    expect(rank(`error`)).toBeLessThan(rank(`pending`));
    expect(rank(`pending`)).toBeLessThan(rank(`inactive`));
    expect(rank(`inactive`)).toBeLessThan(rank(`active`));
    expect(connectionState(`mcp`, instance({ state: `active` })).label).toBe(`ready`);
});

// Two facts at most, in the order somebody would say them; a third would push the state badge off the line.
// `provider`/`platform` are deliberately excluded since they're already the tile's own name.
test(`names a connection by what tells it apart, two facts at most`, () => {
    expect(connectionFacts(instance({ state: `active` }, { host: `ops.acme.dev`, user: `ada`, database: `shop`, platform: `reddit` }))).toBe(
        `ops.acme.dev · shop`,
    );
    expect(connectionFacts(instance({ state: `active` }, { platform: `reddit` }))).toBe(``);
    expect(connectionFacts(instance({ state: `active` }, { host: `  ` }))).toBe(``);
    // An identity-filed account: the tile names the site, so who it belongs to and its purpose fill the whole line.
    expect(
        connectionFacts(
            instance({ state: `active` }, { platform: `reddit`, identity: `radarsuspam2`, purpose: `community research`, openedAt: `2026-08-11` }),
        ),
    ).toBe(`radarsuspam2 · community research`);
});

// Tunnel address/routes come from the live link, never stored config; a down tunnel says nothing here since the
// row's status already does.
test(`reports a tunnel's live address only while it is up`, () => {
    const link = (overrides: Partial<VpnLink>): VpnLink => ({ id: `hq`, state: `connected`, routes: [], ...overrides }) as VpnLink;

    expect(vpnFacts(`hq`, [link({ address: `10.8.0.4`, routes: [`10.0.0.0/8`, `192.168.1.0/24`] })])).toBe(`10.8.0.4 · 10.0.0.0/8, 192.168.1.0/24`);
    // A default route is the one worth naming in words: "all traffic" is what the user actually asked for.
    expect(vpnFacts(`hq`, [link({ address: `10.8.0.4`, routes: [`0.0.0.0/0`] })])).toBe(`10.8.0.4 · all traffic`);
    expect(vpnFacts(`hq`, [link({ state: `disconnected`, address: `10.8.0.4` })])).toBeUndefined();
    expect(vpnFacts(`hq`, [])).toBeUndefined();
});

// The pairing dialog promises what the browser tile's switches say, and says so when every switch is off.
test(`states a browser's grant in its tile's words`, () => {
    const own = (config: Record<string, string>): CapabilitySummary => ({
        id: `chrome`,
        kind: `webext`,
        status: { state: `pending` },
        config,
        secrets: [],
    });

    expect(browserGrants(own({ platform: `chrome` }))).toBe(`read the pages you allow, click and type on them`);
    expect(browserGrants(own({ platform: `chrome`, act: `off`, screenshot: `on` }))).toBe(`read the pages you allow, take screenshots`);
    expect(browserGrants(own({ platform: `chrome`, read: `off`, act: `off` }))).toBe(`nothing until you turn a switch on`);
});
