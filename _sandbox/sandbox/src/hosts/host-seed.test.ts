import { HostConfigSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { hostIdFrom, SETUP_HOST_SCOPES } from "./host-seed.js";

// Setup auto-connects the installer's machine with no explicit consent step, so what it grants is asserted here rather
// than left implicit. A host scope added later must fail this test until someone deliberately decides whether an
// auto-connection gets it.
test("a device connected by setup may manage sandboxes and do nothing else", () => {
    expect(SETUP_HOST_SCOPES).toEqual({
        shell: "off",
        write: "off",
        screen: "off",
        control: "off",
        sandboxes: "on",
        sandboxRemove: "off",
        destructive: "off",
    });
});

test("setup never grants removal or destructive commands", () => {
    expect(SETUP_HOST_SCOPES.sandboxRemove).toBe("off");
    expect(SETUP_HOST_SCOPES.destructive).toBe("off");
});

test("the seeded grant answers for every switch the card has", () => {
    const parsed = HostConfigSchema.parse({ platform: "linux", ...SETUP_HOST_SCOPES });
    const decided = new Set(Object.keys(SETUP_HOST_SCOPES));
    for (const key of Object.keys(parsed)) {
        // `platform` names the card; `roots` is a path list, meaningless with no file access granted.
        if (key === "platform" || key === "roots") {
            continue;
        }
        expect(decided).toContain(key);
    }
});

test("the machine's name becomes an id the agent can address it by", () => {
    expect(hostIdFrom("Ada-Laptop")).toBe("ada-laptop");
    expect(hostIdFrom("ada-laptop.lan")).toBe("ada-laptop");
    expect(hostIdFrom("  Ada's Desktop  ")).toBe("ada-s-desktop");
    expect(hostIdFrom("MACHINE_01")).toBe("machine-01");
});

test("a machine that reports no usable name still gets one", () => {
    expect(hostIdFrom("")).toBe("this-device");
    expect(hostIdFrom("   ")).toBe("this-device");
    expect(hostIdFrom("!!!")).toBe("this-device");
});
