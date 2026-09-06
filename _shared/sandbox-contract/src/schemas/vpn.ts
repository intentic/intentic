// vpn: live tunnel state + connect/disconnect
import { z } from "zod";
// A VPN the agent's traffic rides. One capability = one tunnel, discriminated by `provider` so a new protocol
// is a new arm (plus a driver in the daemon's vpn/), never a reinterpretation of an existing field:
//   wireguard, a pasted .conf, brought up with wg-quick.
//   fortinet , a FortiGate SSL-VPN (what FortiClient's <sslvpn> connections speak), dialled with openconnect
//               --protocol=fortinet. openconnect is the client rather than openfortivpn because it routes over
//               tun instead of pppd: it needs exactly the tun + NET_ADMIN grant this kind already carries, and
//               no /dev/ppp device (which the runtime allowlist does not, and should not, include).
//   ipsec    , an IKEv1/IKEv2 tunnel with a pre-shared key and optional XAuth (FortiClient's <ipsecvpn>
//               connections), run by strongSwan. `aggressive` mirrors FortiClient's dial-up default.
// Connecting is NOT a config field: connect/disconnect are live operations (see vpn.contract.ts) that both the
// user and the agent drive, so a stored tunnel's up/down state is read from the OS, never from the manifest.
// `autoConnect` is the only persisted intent, whether the daemon dials this tunnel again on boot.
export const VpnProviderSchema = z.enum(["wireguard", "fortinet", "ipsec"]);
export type VpnProvider = z.infer<typeof VpnProviderSchema>;
const autoConnect = z.enum(["on", "off"]).default("on");
// FortiClient wraps every stored credential in its own "EncX <hex>" (older builds: "Enc <hex>") encryption,
// keyed to the machine that exported the config, it is NOT recoverable from the file. Pasting one is an easy
// mistake to make, because in the XML it sits exactly where the credential belongs, and the failure it causes
// is unreadable: phase 1 negotiates fine and IKE then reports "calculated HASH does not match HASH payload",
// which says nothing about where the bad value came from. Rejecting it here turns that into a sentence at the
// point of entry. (The FortiClient importer already drops these, this catches a hand-paste.)
// Exported so the add form can flag it inline on blur instead of only on a rejected round-trip, one
// definition of what "this is ciphertext, not a credential" means, shared by the browser and the daemon.
export const isForticlientCiphertext = (value: string): boolean => /^Enc[X]?\s+[0-9A-Fa-f]{8,}$/.test(value.trim());
const notForticlientCiphertext = <T extends z.ZodType<string>>(field: T, label: string): T =>
    field.refine((value) => !isForticlientCiphertext(value), {
        message: `That looks like a value copied straight out of a FortiClient config, FortiClient encrypts it with a key tied to the machine that exported it, so it can't be used here. Enter the actual ${label} (ask whoever administers the gateway).`,
    }) as unknown as T;
export const WireguardVpnConfigSchema = z.object({
    provider: z.literal("wireguard"),
    // The pasted .conf ([Interface] + [Peer]), it holds the private key, so it's this arm's secret field.
    config: z.string().min(1),
    autoConnect,
});
export const FortinetVpnConfigSchema = z.object({
    provider: z.literal("fortinet"),
    // Gateway host only; the port is its own field so a pasted "host:port" can be split on import.
    server: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535).default(443),
    username: z.string().min(1),
    password: notForticlientCiphertext(z.string().min(1), "password"),
    // A FortiGate on a self-signed/private-CA certificate: openconnect pins this digest
    // ("sha256:…", copied from its own refusal message) instead of trusting a CA. Absent ⇒ normal CA validation.
    trustedCert: z.string().min(1).optional(),
    // Some gateways scope a login to a realm/group (openconnect --usergroup, FortiClient's tunnel realm).
    realm: z.string().min(1).optional(),
    autoConnect,
});
export const IpsecVpnConfigSchema = z.object({
    provider: z.literal("ipsec"),
    server: z.string().min(1),
    presharedKey: notForticlientCiphertext(z.string().min(1), "pre-shared key"),
    // The local IKE identity (FortiClient's <localid>), dial-up FortiGates key their phase-1 selection off it.
    localId: z.string().min(1).optional(),
    remoteId: z.string().min(1).optional(),
    // XAuth (FortiClient's <xauth>), absent for PSK-only tunnels.
    username: z.string().min(1).optional(),
    password: notForticlientCiphertext(z.string().min(1), "XAuth password").optional(),
    ikeVersion: z.enum(["1", "2"]).default("1"),
    // Perfect Forward Secrecy for phase 2. Must match the gateway EXACTLY: it decides whether a KE payload is
    // sent in quick mode, and a mismatch fails with NO_PROPOSAL_CHOSEN only after phase 1 and XAuth have
    // succeeded, which reads like anything but a phase 2 problem. FortiClient stores it as <pfs> under
    // <ipsec_settings> and defaults it on, so that is the default here too.
    pfs: z.enum(["on", "off"]).default("on"),
    // The Diffie-Hellman group, as FortiClient numbers them. ONE field for both phases on purpose: in IKEv1
    // strongSwan sends a single KE payload in quick mode and the phase-2 group ends up following phase 1, so
    // offering a phase-1 list that starts with a different group than the gateway wants for phase 2 fails with
    // NO_PROPOSAL_CHOSEN no matter what the esp= line says. 14 (modp2048) is FortiClient's phase-2 default;
    // it is <dhgroup> under <ipsec_settings> in an export.
    dhGroup: z.enum(["2", "5", "14", "15", "16", "19", "20"]).default("14"),
    // IKEv1 aggressive mode: insecure by construction, and exactly what FortiGate dial-up with a group PSK
    // requires, hence opt-in per connection rather than a global strongSwan setting.
    aggressive: z.enum(["on", "off"]).default("on"),
    // WHICH networks ride the tunnel, strongSwan's rightsubnet, the traffic selector this client offers in
    // quick mode. The single most consequential setting on an ipsec tunnel, and the one with no visible symptom
    // until it is wrong: 0.0.0.0/0 offers the gateway EVERYTHING the sandbox sends, including the sandbox's own
    // outbound connection to the model endpoint. A gateway that routes only its own networks accepts that
    // selector, assigns a virtual IP, and then black-holes the rest, so the agent goes silent mid-turn, which
    // reads as the agent breaking rather than as a VPN setting. Narrowing this to the networks actually behind
    // the gateway (10.0.0.0/8,192.168.0.0/16) fixes it with nothing lost: the gateway is asked for less, not for
    // something different, and it needs no change of its own to accept that.
    // Comma-separated because strongSwan takes a list; under IKEv1 each entry is its own CHILD_SA, which not
    // every gateway will negotiate, a list that dials as one entry is a gateway limit, not a config error.
    // The DEFAULT STAYS 0.0.0.0/0: narrowing it for everyone would cut existing tunnels off from networks they
    // reach today, and a full tunnel is right whenever the gateway does route the internet.
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
// The manifest says which VPNs EXIST; this says which are UP right now. Every field is read back from the OS
// (wg show / ip / openconnect's pidfile / swanctl), never remembered by the daemon, so a tunnel the agent
// dropped from a shell and one the UI dropped read identically, and a daemon restart loses nothing.

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
    // The gateway this tunnel dials, host:port for fortinet, the [Peer] endpoint for wireguard, the IKE peer
    // for ipsec. Display only; never a secret.
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
// POST /vpn/{id}/connect body. `otp` is a one-time 2FA code, supplied per dial and NEVER stored, a FortiGate
// with token auth rejects the dial without it, and the daemon surfaces that as a retry-with-a-code error.
export const VpnConnectInputSchema = z.object({
    id: z.string().describe("Which tunnel to dial."),
    otp: z
        .string()
        .min(1)
        .optional()
        .describe("A one-time code, where the gateway wants one. Supplied per dial and never stored; without it such a gateway refuses and says so."),
});
export const VpnIdParamSchema = z.object({ id: z.string().describe("Which tunnel.") });
// POST /vpn/import-forticlient: parse an exported FortiClient configuration (the XML FortiClient writes from
// File → Settings → Backup) into addable connections. Credentials in that file are wrapped in FortiClient's
// proprietary "EncX …" encryption, which is NOT reversible here, so a parsed connection carries the endpoint
// and, when it was stored in the clear, the username; the password is always typed by the user afterwards.
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
    // ipsec-only, and only when the file stored them in the clear.
    localId: z.string().optional().describe("An identity some tunnel types need, when the file stored it readably."),
    aggressive: z.boolean().optional().describe("Which negotiation mode it used."),
    // Phase-2 settings, read from <ipsec_settings>, the pair that decides whether quick mode can succeed.
    pfs: z.boolean().optional().describe("Whether it asked for forward secrecy."),
    dhGroup: z
        .string()
        .optional()
        .describe(
            "Which key-exchange group it used. Together with the setting above, this is what decides whether the connection can complete at all.",
        ),
    // What the user still has to supply for this connection to dial (always at least the password).
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
