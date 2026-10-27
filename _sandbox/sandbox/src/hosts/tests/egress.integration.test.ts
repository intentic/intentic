import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilitySchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Device, DeviceSandbox } from "@intentic/sandbox-contract/schemas/devices";
import type { EgressStatus } from "@intentic/sandbox-contract/schemas/egress";
import { readEgressFenced } from "../../agent/prompt/guidance/egress-fence.js";
import { opt } from "../../opt.js";
import type { StoredCredential } from "../../auth/passkeys/passkey-store.js";
import { commandingCards, withHostShell } from "../egress/host-shell.js";
import { egressOwnerKeysOf, egressRelyingParty } from "../egress/owner-keys.js";
import { egressSuggestionsOf, privateDestination, splitHostPort } from "../egress/suggestions.js";

const credential = (id: string, email: string, rpId: string): StoredCredential => ({
    id,
    email,
    label: `key ${id}`,
    rpId,
    publicKey: { alg: -7, jwk: { kty: "EC", crv: "P-256", x: id, y: id } },
    counter: 0,
    transports: ["hybrid"],
    backedUp: true,
    aaguid: "",
    createdAt: 0,
});

describe("the owner keys a machine pins", () => {
    test("the rpId is the caller's admitted origin, else the editor's", () => {
        const webOrigin = "https://*.preview.example.test, https://app.example.test, http://localhost:5173";
        expect(egressRelyingParty(webOrigin, "http://localhost:5173")).toBe("localhost");
        expect(egressRelyingParty(webOrigin, "https://evil.test")).toBe("app.example.test");
        expect(egressRelyingParty(webOrigin, undefined)).toBe("app.example.test");
        expect(egressRelyingParty("http://localhost:5173", undefined)).toBeUndefined();
    });

    test("only the owner's passkeys for that rpId, with every origin that may sign for it", () => {
        const answer = egressOwnerKeysOf({
            credentials: [
                credential("a", "Owner@Example.test", "app.example.test"),
                credential("b", "member@example.test", "app.example.test"),
                credential("c", "owner@example.test", "localhost"),
            ],
            owner: "owner@example.test",
            rpId: "app.example.test",
            webOrigins: ["https://*.preview.example.test", "https://app.example.test", "http://localhost:5173"],
            app: { rpId: "app.example.test", origins: ["android:apk-key-hash:abc"] },
        });
        expect(answer?.ownerKeys).toEqual({
            rpId: "app.example.test",
            origins: ["https://app.example.test", "android:apk-key-hash:abc"],
            keys: [{ id: "a", alg: -7, jwk: { kty: "EC", crv: "P-256", x: "a", y: "a" }, name: "key a" }],
        });
        expect(answer?.credentials).toEqual([{ id: "a", transports: ["hybrid"] }]);
    });

    test("an app statement for another rpId adds nothing, and no origin at all is no answer", () => {
        const base = { credentials: [], owner: undefined, webOrigins: ["https://app.example.test"], app: { rpId: "other.test", origins: ["android:apk-key-hash:x"] } };
        expect(egressOwnerKeysOf({ ...base, rpId: "app.example.test" })?.ownerKeys).toEqual({ rpId: "app.example.test", origins: ["https://app.example.test"], keys: [] });
        expect(egressOwnerKeysOf({ ...base, rpId: "nowhere.test" })).toBeUndefined();
    });
});

describe("what the cards suggest", () => {
    test("a destination is private by its own spelling only", () => {
        expect(privateDestination("192.168.1.20")).toBe("192.168.1.20");
        expect(privateDestination("100.101.5.6")).toBe("100.101.5.6");
        expect(privateDestination("8.8.8.8")).toBeUndefined();
        expect(privateDestination("NAS.lan.")).toBe("nas.lan");
        expect(privateDestination("nas")).toBe("nas");
        expect(privateDestination("github.com")).toBeUndefined();
        expect(privateDestination("fd12::1")).toBe("fd12::1");
        expect(privateDestination("2001:db8::1")).toBeUndefined();
        expect(privateDestination("host.docker.internal")).toBe("host");
    });

    test("host and port as gateways are written", () => {
        expect(splitHostPort("10.0.0.1:51820")).toEqual({ host: "10.0.0.1", port: 51820 });
        expect(splitHostPort("[fd00::1]:443")).toEqual({ host: "fd00::1", port: 443 });
        expect(splitHostPort("fd00::1")).toEqual({ host: "fd00::1", port: undefined });
        expect(splitHostPort("vpn.lan")).toEqual({ host: "vpn.lan", port: undefined });
    });

    test("an SSH host, a network disk and a VPN gateway on the LAN each suggest their one way through", () => {
        const cards = [
            { id: "nas-ssh", kind: "ssh", config: { auth: "password", host: "192.168.1.5", port: 2222, user: "me", password: "x" } },
            { id: "public-ssh", kind: "ssh", config: { auth: "password", host: "example.com", port: 22, user: "me", password: "x" } },
            { id: "photos", kind: "netdisk", config: { provider: "smb", server: "nas.lan", share: "photos", username: "me" } },
            { id: "office", kind: "vpn", config: { provider: "wireguard", config: "[Peer]\nEndpoint = 10.1.0.1:51820\n", autoConnect: "off" } },
        ].map((card) => CapabilitySchema.parse(card));
        expect(egressSuggestionsOf(cards)).toEqual([
            { to: "192.168.1.5", ports: [2222], protocol: "tcp", from: "nas-ssh", note: "SSH host (nas-ssh)" },
            { to: "nas.lan", ports: [445], protocol: "tcp", from: "photos", note: "Network disk (photos)" },
            { to: "10.1.0.1", ports: [51820], protocol: "udp", from: "office", note: "VPN gateway (office)" },
        ]);
    });
});

describe("a command grant on the sandbox's own machine", () => {
    const status: EgressStatus = { policy: { profile: "internet-only", allow: [] }, revision: "1", effectiveProfile: "internet-only", neverAllow: [], state: "enforced", blocked: [] };
    const box = (slug: string, egress?: EgressStatus): DeviceSandbox => ({ slug, container: `intentic-sandbox-${slug}`, running: true, image: "img", ...opt("egress", egress) });
    const rows: Device[] = [
        { key: "pc", label: "pc", card: "pc", machineId: "m1", sandboxes: [box("work", status), box("other", status)] },
        { key: "pc-wsl", label: "pc", card: "pc-wsl", machineId: "m1" },
        { key: "laptop", label: "laptop", card: "laptop", machineId: "m2", sandboxes: [box("work", status)] },
    ];

    test("shell or programs on: the card runs commands out there", () => {
        const cards = [
            { id: "pc-wsl", kind: "device", config: { platform: "linux", shell: "on" } },
            { id: "laptop", kind: "device", config: { platform: "linux", shell: "off", programs: "off" } },
            { id: "phone", kind: "device", config: { platform: "linux", shell: "off", programs: "on" } },
        ].map((card) => CapabilitySchema.parse(card));
        expect([...commandingCards(cards)]).toEqual(["pc-wsl", "phone"]);
    });

    test("is said on this sandbox's own row of the machine any of its sides grants commands on", () => {
        const said = withHostShell(rows, "work", new Set(["pc-wsl"]));
        expect(said[0]?.sandboxes?.map((sandbox) => sandbox.egress?.hostShell)).toEqual([true, undefined]);
        expect(said[2]?.sandboxes?.[0]?.egress?.hostShell).toBe(false);
        expect(withHostShell(rows, undefined, new Set(["pc-wsl"]))).toBe(rows);
    });
});

test("an agent is told of the fence only while ic says it is enforced", () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-"));
    const file = join(dir, "egress.json");
    expect(readEgressFenced(file)).toBe(false);
    const status = { policy: { profile: "internet-only", allow: [] }, revision: "3", effectiveProfile: "internet-only", neverAllow: [], state: "enforced", blocked: [] };
    writeFileSync(file, JSON.stringify(status));
    expect(readEgressFenced(file)).toBe(true);
    writeFileSync(file, JSON.stringify({ ...status, state: "pending" }));
    expect(readEgressFenced(file)).toBe(false);
    writeFileSync(file, "not json");
    expect(readEgressFenced(file)).toBe(false);
});
