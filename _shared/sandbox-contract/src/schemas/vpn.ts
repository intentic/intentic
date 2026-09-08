// vpn: live tunnel state + connect/disconnect
import { z } from "zod";
// One capability = one tunnel, discriminated by provider; a new protocol is a new arm, never a reinterpretation of an
// existing field.
// wireguard: a pasted .conf, brought up with wg-quick.
// fortinet: FortiGate SSL-VPN, dialled via openconnect --protocol=fortinet (needs tun + NET_ADMIN, not /dev/ppp).
// ipsec: IKEv1/IKEv2 with a pre-shared key and optional XAuth, run by strongSwan.
// Connecting is a live operation read from the OS, never stored; autoConnect is the only persisted intent.
export const VpnProviderSchema = z.enum(["wireguard", "fortinet", "ipsec"]);
export type VpnProvider = z.infer<typeof VpnProviderSchema>;
const autoConnect = z.enum(["on", "off"]).default("on");
// FortiClient wraps stored credentials in "EncX <hex>" (or older "Enc <hex>") encryption keyed to the exporting
// machine; not recoverable from the file. Rejected here since pasting one fails unreadably at IKE instead.
export const isForticlientCiphertext = (value: string): boolean => /^Enc[X]?\s+[0-9A-Fa-f]{8,}$/.test(value.trim());
const notForticlientCiphertext = <T extends z.ZodType<string>>(field: T, label: string): T =>
    field.refine((value) => !isForticlientCiphertext(value), {
        message: `That looks like a value copied straight out of a FortiClient config, FortiClient encrypts it with a key tied to the machine that exported it, so it can't be used here. Enter the actual ${label} (ask whoever administers the gateway).`,
    }) as unknown as T;
export const WireguardVpnConfigSchema = z.object({
    provider: z.literal("wireguard"),
    // The pasted .conf ([Interface] + [Peer]); holds the private key, so it's this arm's secret field.
    config: z.string().min(1),
    autoConnect,
});
export const FortinetVpnConfigSchema = z.object({
    provider: z.literal("fortinet"),
    // Gateway host only; port is separate so a pasted "host:port" can be split on import.
    server: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535).default(443),
    username: z.string().min(1),
    password: notForticlientCiphertext(z.string().min(1), "password"),
    // Cert pin ("sha256:...") for a self-signed gateway; absent means normal CA validation.
    trustedCert: z.string().min(1).optional(),
    // Login realm/group some gateways require (openconnect --usergroup).
    realm: z.string().min(1).optional(),
    autoConnect,
});
export const IpsecVpnConfigSchema = z.object({
    provider: z.literal("ipsec"),
    server: z.string().min(1),
    presharedKey: notForticlientCiphertext(z.string().min(1), "pre-shared key"),
    // Local IKE identity; dial-up FortiGates key their phase-1 selection off it.
    localId: z.string().min(1).optional(),
    remoteId: z.string().min(1).optional(),
    // XAuth credentials; absent for PSK-only tunnels.
    username: z.string().min(1).optional(),
    password: notForticlientCiphertext(z.string().min(1), "XAuth password").optional(),
    ikeVersion: z.enum(["1", "2"]).default("1"),
    // Must match the gateway exactly, or it fails with NO_PROPOSAL_CHOSEN after phase 1 and XAuth succeed.
    pfs: z.enum(["on", "off"]).default("on"),
    // One field for both phases: IKEv1 reuses the phase-1 group in quick mode, or it fails NO_PROPOSAL_CHOSEN.
    dhGroup: z.enum(["2", "5", "14", "15", "16", "19", "20"]).default("14"),
    // IKEv1 aggressive mode: insecure by construction, required by FortiGate dial-up with a group PSK.
    aggressive: z.enum(["on", "off"]).default("on"),
    // strongSwan's rightsubnet, comma-separated CIDRs; default stays 0.0.0.0/0 so existing tunnels aren't narrowed.
    routedNetworks: z
        .string()
        .default("0.0.0.0/0")
        .refine(
            (value) =>
                value
                    .split(",")
                    .map((entry) => entry.trim())
                    .every((entry) => z.cidrv4().safeParse(entry).success || z.cidrv6().safeParse(entry).success),
            {
                message:
                    "Routed networks is a comma-separated list of CIDRs, like 10.0.0.0/8,192.168.0.0/16. A single host needs its prefix too (192.168.0.168/32). Leave it at 0.0.0.0/0 to send everything through the gateway.",
            },
        ),
    autoConnect,
});
export const VpnConfigSchema = z.discriminatedUnion("provider", [WireguardVpnConfigSchema, FortinetVpnConfigSchema, IpsecVpnConfigSchema]);
export type WireguardVpnConfig = z.infer<typeof WireguardVpnConfigSchema>;
export type FortinetVpnConfig = z.infer<typeof FortinetVpnConfigSchema>;
export type IpsecVpnConfig = z.infer<typeof IpsecVpnConfigSchema>;
export type VpnConfig = z.infer<typeof VpnConfigSchema>;
// Manifest says which VPNs exist; this says which are up. Every field reads live from the OS, never remembered, so a
// restart loses nothing.

export const VpnStateSchema = z.enum([
    // The tunnel is up and carrying traffic.
    "connected",
    // Dialling: openconnect authenticated but the interface has no address yet, or strongSwan is negotiating.
    "connecting",
    // Configured and idle, the normal resting state for a tunnel nobody asked for.
    "disconnected",
    // The tunnel's client isn't installed yet: the capability's image fragment needs an owner-run rebuild.
    "unavailable",
    // The last dial failed; `detail` carries the client's own message.
    "failed",
]);
export type VpnState = z.infer<typeof VpnStateSchema>;
export const VpnLinkSchema = z.object({
    id: z.string().describe("Which tunnel."),
    provider: VpnProviderSchema.describe("What kind of tunnel it is."),
    state: VpnStateSchema.describe(
        "Whether it is up, dialling, resting, failed, or not installable yet because its client needs a rebuild to arrive.",
    ),
    // The gateway dialled: host:port, a wireguard peer, or an ipsec peer. Display only, never a secret.
    gateway: z.string().optional().describe("What it dials. For display only, and never a credential."),
    // The tun/wg interface carrying the tunnel, once it exists.
    interface: z.string().optional().describe("The network interface carrying it, once one exists."),
    // The address the gateway assigned this sandbox, the single most useful "am I on the VPN?" fact.
    address: z
        .string()
        .optional()
        .describe("The address the far end gave this sandbox, which is the single most useful answer to whether you are on the VPN."),
    // The CIDRs routed into the tunnel ("0.0.0.0/0" = full tunnel). Empty until the link is up.
    routes: z
        .array(z.string())
        .default([])
        .describe("What goes through it. Everything, when the range covers the whole internet. Empty until it is up."),
    // DNS servers the tunnel pushed, when it pushed any.
    dns: z.array(z.string()).default([]).describe("Name servers it pushed, when it pushed any."),
    // Epoch ms the link came up, the UI renders "connected 14m ago". Absent unless connected.
    since: z.number().optional().describe("When it came up, in milliseconds. Absent unless it is."),
    // Whether the daemon re-dials this tunnel on boot (the manifest's autoConnect).
    autoConnect: z.boolean().describe("Whether it dials itself when the sandbox starts."),
    // Why it is failed/unavailable, or an extra note on a healthy link. Never carries credentials.
    detail: z.string().optional().describe("Why it failed, or a note about a healthy one. Never a credential."),
});
export type VpnLink = z.infer<typeof VpnLinkSchema>;
export const VpnListSchema = z.object({
    links: z
        .array(VpnLinkSchema)
        .describe("Every configured tunnel with its live state, read back from the operating system each time rather than remembered."),
});
// otp is a one-time 2FA code, supplied per dial and never stored; a token-auth gateway rejects the dial without it.
export const VpnConnectInputSchema = z.object({
    id: z.string().describe("Which tunnel to dial."),
    otp: z
        .string()
        .min(1)
        .optional()
        .describe("A one-time code, where the gateway wants one. Supplied per dial and never stored; without it such a gateway refuses and says so."),
});
export const VpnIdParamSchema = z.object({ id: z.string().describe("Which tunnel.") });
// Parses an exported FortiClient XML into addable connections. EncX-wrapped credentials are not reversible: only the
// endpoint and any cleartext username come through; the password is always typed later.
export const ForticlientImportInputSchema = z.object({
    xml: z.string().min(1).describe("The exported configuration file, whole. Nothing is stored: it is read and thrown away."),
});
export const ForticlientConnectionSchema = z.object({
    // FortiClient's connection name, slugged into a legal capability id.
    id: z.string().describe("The id it would be added under."),
    // The original <name>, shown so the user recognises the connection they picked.
    label: z.string().describe("Its name as the file has it, so somebody recognises the connection they are picking."),
    provider: VpnProviderSchema.describe("What kind of tunnel it is."),
    server: z.string().describe("Where it dials."),
    port: z.number().describe("On which port."),
    // Present only when FortiClient stored it unencrypted; an EncX-wrapped username is dropped, not guessed.
    username: z
        .string()
        .optional()
        .describe("The username, but only when the file stored it in the clear. An encrypted one is dropped rather than guessed at."),
    description: z.string().optional().describe("Whatever the file said about it."),
    // ipsec-only; present only when the file stored it in the clear.
    localId: z.string().optional().describe("An identity some tunnel types need, when the file stored it readably."),
    aggressive: z.boolean().optional().describe("Which negotiation mode it used."),
    // Phase-2 settings from <ipsec_settings>; together they decide whether quick mode can succeed.
    pfs: z.boolean().optional().describe("Whether it asked for forward secrecy."),
    dhGroup: z
        .string()
        .optional()
        .describe(
            "Which key-exchange group it used. Together with the setting above, this is what decides whether the connection can complete at all.",
        ),
    // What the user must still type in before it can dial; always at least the password.
    needs: z
        .array(z.string())
        .describe(
            "What you still have to type in before it can dial. Always at least the password, because the export wraps credentials in encryption that cannot be undone here.",
        ),
});
export type ForticlientConnection = z.infer<typeof ForticlientConnectionSchema>;
export const ForticlientImportSchema = z.object({
    connections: z.array(ForticlientConnectionSchema).describe("The connections found in the file, ready to be added one at a time."),
});
