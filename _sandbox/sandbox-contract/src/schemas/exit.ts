// Geo exits: somewhere the agent's traffic can LEAVE from, so a page fetches as if read elsewhere. Its own
// capability kind rather than a fourth `vpn` provider — an exit routes NOTHING into the main table.
import { z } from "zod";
import { autoStart } from "./internal.js";
/* A GEO EXIT: somewhere the agent's traffic can LEAVE from, so a page fetches as if read in Berlin or Osaka.
 * Its own kind rather than a fourth `vpn` provider, and the distinction is the whole reason this works:
 *
 *   a `vpn` REACHES a private network , one stored gateway, dialled, pushing its routes into the main table.
 *   an `exit` LEAVES from somewhere else, a POOL with a catalog, switched at runtime, routing NOTHING into
 *     the main table.
 *
 * That last clause is load-bearing. An exit is a full tunnel by definition, and a full tunnel on the main
 * table swallows the sandbox's own uplink, the model endpoint and the tunnel that makes this sandbox
 * reachable, which reads to a user as the agent breaking mid-turn (see IpsecVpnConfigSchema.routedNetworks
 * for the same trap on the vpn kind). So an exit never touches the default route. It publishes a local SOCKS
 * proxy and callers opt in: a browser account naming it, `curl --proxy`, and nothing else. The side benefit
 * is trust, a volunteer relay carries only what was pointed at it, never the agent's own working traffic.
 *
 * Three providers, chosen because each is reachable with no paid account:
 *   tor      , the Tor network. ~52 exit countries, no account, no credentials, no privileges: it is a SOCKS
 *              proxy already. Country is a torrc line, a new IP is a control-port signal. The free default.
 *   vpngate  , the University of Tsukuba's volunteer relay pool. No account; its public CSV IS the catalog,
 *              so servers auto-fill. Overwhelmingly Japan/Korea in practice, which is the half of the map Tor
 *              covers worst, so the two complement rather than duplicate.
 *   wireguard, bring your own .conf files, one per country, from a provider's dashboard (Proton VPN's free
 *              tier, Mullvad, anything). The catalog is built by parsing what was pasted.
 * Starting, switching country and rotating are LIVE operations (see exit.contract.ts), never config, so an
 * exit's real state is read off the machine. `country` is the resting preference and `autoStart` the only
 * other persisted intent. */
export const ExitProviderSchema = z.enum(["tor", "vpngate", "wireguard"]);
export type ExitProvider = z.infer<typeof ExitProviderSchema>;
// An ISO 3166-1 alpha-2 code, normalised up so "de", "DE" and "De" are one country rather than three. The
// catalogs, the CLI and the manifest all speak this one spelling.
export const CountryCodeSchema = z
    .string()
    .regex(/^[A-Za-z]{2}$/, "A country is its two-letter code, like DE, US or JP.")
    .transform((value) => value.toUpperCase());
export const TorExitConfigSchema = z.object({
    provider: z.literal("tor"),
    // Where to come out, when nothing has asked for somewhere else. Absent ⇒ let Tor choose, which is both
    // faster and kinder to the network.
    country: CountryCodeSchema.optional(),
    autoStart,
});
export const VpngateExitConfigSchema = z.object({
    provider: z.literal("vpngate"),
    country: CountryCodeSchema.optional(),
    autoStart,
});
export const WireguardExitConfigSchema = z.object({
    /* One or more WireGuard .conf files in one field, pasted back to back. One field rather than one
     * capability per country because they are one POOL: the whole point is switching between them under a
     * proxy port that never moves, and a user with five Proton free countries should not add five capabilities
     * to get five countries out of one account.
     *
     * Country per conf comes from an optional `# country: DE` line, else from the provider's own naming
     * convention in the Endpoint host (Proton's `de-free-01.protonvpn.net`, Mullvad's `de-ber-wg-001`), else
     * from a lookup through the tunnel once it is up. Whole thing is the secret: each conf holds a private key. */
    provider: z.literal("wireguard"),
    config: z.string().min(1),
    country: CountryCodeSchema.optional(),
    autoStart,
});
export const ExitConfigSchema = z.discriminatedUnion("provider", [TorExitConfigSchema, VpngateExitConfigSchema, WireguardExitConfigSchema]);
export type TorExitConfig = z.infer<typeof TorExitConfigSchema>;
export type VpngateExitConfig = z.infer<typeof VpngateExitConfigSchema>;
export type WireguardExitConfig = z.infer<typeof WireguardExitConfigSchema>;
export type ExitConfig = z.infer<typeof ExitConfigSchema>;
// The manifest says which exits EXIST; this says which are up, where they come out, and what the world sees.
// Read off the machine and off the wire, never remembered: an exit the agent stopped from a shell and one the
// UI stopped read identically, and a daemon restart observes the truth rather than a stale guess.

export const ExitStateSchema = z.enum([
    // Carrying traffic: the proxy is listening and the last check came out where it was asked to.
    "up",
    // Coming up, or moving to another country. The proxy port may already be open and not yet where you want.
    "starting",
    // Configured and idle. The resting state, and the default one: exits are not held open for nothing.
    "down",
    // The client isn't installed yet (tor, openvpn): the capability's image fragment needs an owner rebuild.
    "unavailable",
    // The last start or switch failed; `detail` carries the reason.
    "failed",
]);
export type ExitState = z.infer<typeof ExitStateSchema>;
/* WHAT THE WORLD SEES, fetched THROUGH the exit's own proxy. This is the load-bearing type of the whole
 * feature: "switch to Germany" is worth nothing as a report that a tunnel came up, and worth everything as a
 * report that the egress address is now German. Every start, use and rotate ends by producing one of these,
 * and a switch that cannot produce one fails instead of quietly leaving traffic where it was. */
export const ExitObservationSchema = z.object({
    ip: z.string().describe("The address the world sees, looked up through the exit's own proxy rather than assumed."),
    // Absent when the lookup answered with an address but no country: a switch is judged on the country when
    // one is known, and on the address having CHANGED when it is not.
    country: z
        .string()
        .optional()
        .describe(
            "Which country that address is in. Absent when the lookup gave an address and no country, in which case a switch is judged on the address having changed instead.",
        ),
    countryName: z.string().optional().describe("That country's name, spelled out."),
});
export type ExitObservation = z.infer<typeof ExitObservationSchema>;
/* One country an exit can come out of, as the picker and `exit countries` render it. `servers` and `share`
 * are what stop a country list being a lie: Tor lists 52 countries and a third of them are one underpowered
 * relay, so the ranking has to carry how much is actually there, not just that the flag exists. */
export const ExitPointSchema = z.object({
    country: z.string().describe("The country's code."),
    countryName: z.string().describe("Its name, spelled out."),
    // How many relays/servers this provider has there right now.
    servers: z.number().describe("How many servers this provider has there."),
    // This country's share of the provider's total exit capacity, 0..1. Used to sort and to grey out the
    // countries that technically exist and practically do not.
    share: z
        .number()
        .optional()
        .describe(
            "How much of the provider's actual capacity is there, from zero to one. This is what a list should be sorted by: a third of the countries on offer are one overloaded machine behind a flag, and a count of servers would rank them first.",
        ),
});
export type ExitPoint = z.infer<typeof ExitPointSchema>;
export const ExitCountriesSchema = z.object({
    countries: z.array(ExitPointSchema).describe("Where this exit can put you, best-supplied first."),
    // Whether this list came off the provider live or out of the baked fallback (no network, or the provider
    // is down). The picker says so rather than presenting a stale list as current.
    live: z
        .boolean()
        .describe("Whether the provider answered, or this came from a built-in list. Said out loud rather than presenting an old list as current."),
});
export const ExitLinkSchema = z.object({
    id: z.string().describe("Which exit."),
    provider: ExitProviderSchema.describe("What it runs on."),
    state: ExitStateSchema.describe(
        "Whether it is carrying traffic, coming up, resting, failed, or not installable yet because its client needs a rebuild to arrive.",
    ),
    // The SOCKS endpoint callers point at. Fixed per exit and stable across country switches, which is what
    // lets a long task change country halfway without reconfiguring anything downstream.
    proxy: z
        .string()
        .describe(
            "Where to point traffic that should go through it. Fixed per exit and unchanged by a country switch, which is what lets a long job move country halfway through without reconfiguring anything.",
        ),
    // The country ASKED for (manifest preference, or the last `use`). Absent = provider's choice.
    country: z.string().optional().describe("Where it was asked to come out. Absent means the provider chose."),
    // The country actually OBSERVED at the last check, and the address behind it. These two disagreeing is
    // the single most useful fault signal this feature has, so they are separate fields, never merged.
    observedCountry: z
        .string()
        .optional()
        .describe(
            "Where it actually comes out, as last checked. Kept separate from what was asked for, because those two disagreeing is the most useful fault signal this whole feature has.",
        ),
    ip: z.string().optional().describe("The address behind that observation."),
    // Epoch ms of the observation above, so a stale reading can be rendered as stale.
    checkedAt: z.number().optional().describe("When that was checked, in milliseconds, so an old reading can be shown as old."),
    // The tunnel interface, for the providers that have one (vpngate, wireguard). Tor has none by design.
    interface: z.string().optional().describe("The network interface, for the kinds that have one."),
    since: z.number().optional().describe("When it came up, in milliseconds."),
    autoStart: z.boolean().describe("Whether it starts itself when the sandbox does."),
    detail: z.string().optional().describe("Why it failed, or a note about a healthy one."),
});
export type ExitLink = z.infer<typeof ExitLinkSchema>;
export const ExitListSchema = z.object({
    links: z.array(ExitLinkSchema).describe("Every configured exit, with where it was asked to come out and where it actually does."),
});
/* WHERE EACH FREE PROVIDER CAN ACTUALLY COME OUT, as measured, and the reason it lives in the contract rather
 * than in the daemon: two consumers need the same answer and must not drift. The daemon uses it as the
 * FALLBACK catalog when a provider's own list cannot be fetched; the add form uses it to fill the country
 * picker, so a user chooses from a list instead of guessing a code and finding out later that nothing serves
 * it. A second copy of these numbers would let the picker offer a country the driver cannot dial.
 *
 * `share` is the country's slice of the provider's exit capacity, and it is the number that matters. A third
 * of Tor's fifty-two countries are one overloaded relay behind a flag; ranking by relay COUNT alone would put
 * the United States first on 1,171 slow relays when the Netherlands carries three times the traffic on half as
 * many. Both surfaces sort on this so the top of the list is the part that works.
 *
 * Measured 2026-08-21 from onionoo.torproject.org and vpngate.net's public CSV. Stale by construction, which
 * is exactly why the daemon prefers a live fetch and labels this one as not-live when it falls back to it. */
export const TOR_EXIT_COUNTRIES: readonly ExitPoint[] = [
    { country: "NL", countryName: "Netherlands", servers: 607, share: 0.304 },
    { country: "DE", countryName: "Germany", servers: 415, share: 0.242 },
    { country: "SE", countryName: "Sweden", servers: 344, share: 0.14 },
    { country: "US", countryName: "United States", servers: 1171, share: 0.097 },
    { country: "AT", countryName: "Austria", servers: 123, share: 0.054 },
    { country: "LU", countryName: "Luxembourg", servers: 92, share: 0.033 },
    { country: "FR", countryName: "France", servers: 63, share: 0.032 },
    { country: "NO", countryName: "Norway", servers: 54, share: 0.026 },
    { country: "RO", countryName: "Romania", servers: 71, share: 0.011 },
    { country: "DK", countryName: "Denmark", servers: 15, share: 0.007 },
    { country: "HU", countryName: "Hungary", servers: 20, share: 0.006 },
    { country: "IT", countryName: "Italy", servers: 15, share: 0.006 },
    { country: "UA", countryName: "Ukraine", servers: 23, share: 0.006 },
    { country: "CH", countryName: "Switzerland", servers: 23, share: 0.006 },
    { country: "IS", countryName: "Iceland", servers: 23, share: 0.003 },
    { country: "PL", countryName: "Poland", servers: 8, share: 0.002 },
    { country: "BG", countryName: "Bulgaria", servers: 17, share: 0.002 },
    { country: "GB", countryName: "United Kingdom", servers: 8, share: 0.002 },
    { country: "FI", countryName: "Finland", servers: 13, share: 0.002 },
];
// VPN Gate, and its shape is the honest headline: 87% of its pool is Japan and Korea. That is not a defect to
// hide behind a long country list, it is the reason to have it, Tor's Asian exit capacity is close to nothing,
// so the two providers cover each other rather than overlapping.
export const VPNGATE_EXIT_COUNTRIES: readonly ExitPoint[] = [
    { country: "JP", countryName: "Japan", servers: 46, share: 0.48 },
    { country: "KR", countryName: "Korea, South", servers: 37, share: 0.39 },
    { country: "VN", countryName: "Vietnam", servers: 3, share: 0.03 },
    { country: "TH", countryName: "Thailand", servers: 2, share: 0.02 },
    { country: "RU", countryName: "Russia", servers: 2, share: 0.02 },
    { country: "RO", countryName: "Romania", servers: 1, share: 0.01 },
    { country: "MX", countryName: "Mexico", servers: 1, share: 0.01 },
    { country: "IN", countryName: "India", servers: 1, share: 0.01 },
    { country: "CN", countryName: "China", servers: 1, share: 0.01 },
    { country: "BY", countryName: "Belarus", servers: 1, share: 0.01 },
];
export const ExitIdParamSchema = z.object({ id: z.string().describe("Which exit.") });
// POST /exit/{id}/use body. An absent country means "let the provider choose", the same thing an absent
// `country` in the manifest means, so clearing a country is expressible rather than only setting one.
export const ExitUseInputSchema = z.object({
    id: z.string().describe("Which exit."),
    country: CountryCodeSchema.optional().describe(
        "Where to come out. Leaving it out means letting the provider choose, so clearing a country is something you can actually say rather than only setting one.",
    ),
});
