import { test, expect } from "bun:test";
import { CapabilitiesListSchema } from "./capabilities.js";
import { SandboxSettingsSchema } from "./settings.js";
import { SmbNetdiskConfigSchema } from "./netdisk.js";
import { IpsecVpnConfigSchema } from "./vpn.js";

// Settings cross a version seam: the browser can be newer than the daemon. An absent key must parse as that field's
// default, never a failure.

test("a payload from a build that predates a toggle parses, with the new toggle at its default", () => {
    // What a pre-output-cleaner-switch daemon sent: every key it knew, nothing for the one added after.
    const older = {
        stableSystemPrompt: false,
        skills: [],
        hashlineEdits: false,
        iqSearch: true,
        outputCleaners: "-cap",
        outputHoldout: 0.1,
    };
    // Defaults come from the schema itself, not copied here, so a new setting doesn't fail this test.
    expect(SandboxSettingsSchema.parse(older)).toEqual({ ...SandboxSettingsSchema.parse({}), ...older });
});

test("no field is required: a workspace that has never written settings parses", () => {
    const defaults = SandboxSettingsSchema.parse({});
    expect(Object.keys(defaults).toSorted()).toEqual(Object.keys(SandboxSettingsSchema.shape).toSorted());
});

test("a key of the wrong type is still a parse failure: tolerance is for absence, not for garbage", () => {
    expect(SandboxSettingsSchema.safeParse({ iqSearch: "yes" }).success).toBe(false);
    expect(SandboxSettingsSchema.safeParse({ outputHoldout: 4 }).success).toBe(false);
    expect(SandboxSettingsSchema.safeParse({ systemPrompt: "x".repeat(20001) }).success).toBe(false);
});

// The capability list crosses the same seam; a required key an older daemon omits can take down the whole Capabilities
// page, not just one switch.

test("a capability list from a daemon that predates recommendations parses, with none recommended", () => {
    const older = { capabilities: [{ id: "github", kind: "cli", status: { state: "active" }, config: { provider: "github" } }] };
    expect(CapabilitiesListSchema.parse(older).recommendations).toEqual([]);
});

// routedNetworks decides split vs full tunnel; an unchecked bad value makes charon reject the whole config, not just
// this field. Default must stay 0.0.0.0/0.
const ipsec = { provider: "ipsec", server: "gw.example.com", presharedKey: "group-secret" };

test("an ipsec tunnel is a full tunnel unless it says otherwise", () => {
    expect(IpsecVpnConfigSchema.parse(ipsec).routedNetworks).toBe("0.0.0.0/0");
});

test("routed networks take a CIDR list and reject what charon could not load", () => {
    expect(IpsecVpnConfigSchema.parse({ ...ipsec, routedNetworks: "10.0.0.0/8, 192.168.0.0/16" }).routedNetworks).toBe("10.0.0.0/8, 192.168.0.0/16");
    expect(IpsecVpnConfigSchema.parse({ ...ipsec, routedNetworks: "fd00::/8" }).routedNetworks).toBe("fd00::/8");
    // A bare host address (no prefix) is the common mistake strongSwan rejects.
    expect(IpsecVpnConfigSchema.safeParse({ ...ipsec, routedNetworks: "192.168.0.168" }).success).toBe(false);
    expect(IpsecVpnConfigSchema.safeParse({ ...ipsec, routedNetworks: "10.0.0.0/8,nonsense" }).success).toBe(false);
    expect(IpsecVpnConfigSchema.safeParse({ ...ipsec, routedNetworks: "" }).success).toBe(false);
});

const smb = { provider: "smb", server: "nas.local", share: "archive", username: "agent" };

test("a network disk is read-only, auto-negotiated and mounted on start unless it says otherwise", () => {
    const parsed = SmbNetdiskConfigSchema.parse(smb);
    expect(parsed.access).toBe("read");
    expect(parsed.version).toBe("auto");
    expect(parsed.autoMount).toBe("on");
    expect(parsed.password).toBeUndefined();
});

test("server and share are single names, and the folder inside stays inside", () => {
    expect(SmbNetdiskConfigSchema.safeParse({ ...smb, server: "//nas.local/x" }).success).toBe(false);
    expect(SmbNetdiskConfigSchema.safeParse({ ...smb, share: "archive/2026" }).success).toBe(false);
    expect(SmbNetdiskConfigSchema.safeParse({ ...smb, path: "2026/q3" }).success).toBe(true);
    expect(SmbNetdiskConfigSchema.safeParse({ ...smb, path: "/2026" }).success).toBe(false);
    expect(SmbNetdiskConfigSchema.safeParse({ ...smb, path: "../etc" }).success).toBe(false);
});
