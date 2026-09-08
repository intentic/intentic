// Geo exits: somewhere the agent's traffic can leave from, so a page fetches as if read elsewhere.
import { z } from "zod";
import { autoStart } from "./internal.js";
// An exit never touches the default route: it publishes a local SOCKS proxy callers opt into (a browser account, `curl
// --proxy`); a `vpn` capability instead pushes routes into the main table.
// tor: the Tor network, already a SOCKS proxy, no account needed.
// vpngate: University of Tsukuba's volunteer pool; its public CSV is the catalog.
// wireguard: user-supplied .conf files from any provider, one pool per country.
export const ExitProviderSchema = z.enum(["tor", "vpngate", "wireguard"]);
export type ExitProvider = z.infer<typeof ExitProviderSchema>;
// ISO 3166-1 alpha-2 code, normalised to uppercase so "de"/"DE"/"De" are one country; catalogs, CLI and manifest all
// speak this spelling.
export const CountryCodeSchema = z
    .string()
    .regex(/^[A-Za-z]{2}$/, "A country is its two-letter code, like DE, US or JP.")
    .transform((value) => value.toUpperCase());
export const TorExitConfigSchema = z.object({
    provider: z.literal("tor"),
    // Absent means let Tor choose its own exit, which is faster and kinder to the network.
    country: CountryCodeSchema.optional(),
    autoStart,
});
export const VpngateExitConfigSchema = z.object({
    provider: z.literal("vpngate"),
    country: CountryCodeSchema.optional(),
    autoStart,
});
export const WireguardExitConfigSchema = z.object({
    // One or more WireGuard .conf files pasted back to back; each holds a private key, so the field is a secret.
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
// Manifest says which exits exist; this says which are up, where, and what the world sees — read off the machine and
// wire, never remembered, so a restart observes the truth rather than a stale guess.

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
// What the world sees, fetched through the exit's own proxy. Every start, use and rotate ends by producing one; a
// switch that cannot produce one fails rather than silently leaving traffic where it was.
export const ExitObservationSchema = z.object({
    ip: z.string().describe("The address the world sees, looked up through the exit's own proxy rather than assumed."),
    country: z
        .string()
        .optional()
        .describe(
            "Which country that address is in. Absent when the lookup gave an address and no country, in which case a switch is judged on the address having changed instead.",
        ),
    countryName: z.string().optional().describe("That country's name, spelled out."),
});
export type ExitObservation = z.infer<typeof ExitObservationSchema>;
// One country an exit can come out of. `servers` and `share` keep the list honest: many listed countries are one
// underpowered relay, not real capacity.
export const ExitPointSchema = z.object({
    country: z.string().describe("The country's code."),
    countryName: z.string().describe("Its name, spelled out."),
    servers: z.number().describe("How many servers this provider has there."),
    // Also used to grey out countries that technically exist but carry no real capacity.
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
    // True from a live fetch, false from the baked fallback (no network, or the provider is down).
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
    proxy: z
        .string()
        .describe(
            "Where to point traffic that should go through it. Fixed per exit and unchanged by a country switch, which is what lets a long job move country halfway through without reconfiguring anything.",
        ),
    // Manifest preference, or the last `use` call.
    country: z.string().optional().describe("Where it was asked to come out. Absent means the provider chose."),
    observedCountry: z
        .string()
        .optional()
        .describe(
            "Where it actually comes out, as last checked. Kept separate from what was asked for, because those two disagreeing is the most useful fault signal this whole feature has.",
        ),
    ip: z.string().optional().describe("The address behind that observation."),
    checkedAt: z.number().optional().describe("When that was checked, in milliseconds, so an old reading can be shown as old."),
    // vpngate and wireguard have one; Tor has none by design.
    interface: z.string().optional().describe("The network interface, for the kinds that have one."),
    since: z.number().optional().describe("When it came up, in milliseconds."),
    autoStart: z.boolean().describe("Whether it starts itself when the sandbox does."),
    detail: z.string().optional().describe("Why it failed, or a note about a healthy one."),
});
export type ExitLink = z.infer<typeof ExitLinkSchema>;
export const ExitListSchema = z.object({
    links: z.array(ExitLinkSchema).describe("Every configured exit, with where it was asked to come out and where it actually does."),
});
// Shared fallback catalog for the daemon and the add-form picker, so the two cannot drift. Ranked by `share`, not
// server count, since count alone misrepresents real capacity; stale by construction, always marked not-live when used.
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
// Skewed to Japan/Korea by design, complementing Tor's weak Asian coverage rather than duplicating it.
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
// POST /exit/{id}/use body; absent `country` matches what an absent one means in the manifest.
export const ExitUseInputSchema = z.object({
    id: z.string().describe("Which exit."),
    country: CountryCodeSchema.optional().describe(
        "Where to come out. Leaving it out means letting the provider choose, so clearing a country is something you can actually say rather than only setting one.",
    ),
});
