import { DeviceConfigSchema } from "@intentic/sandbox-contract";
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
        destructive: "off",
    });
});

// `sandboxes` carries the whole container lifecycle, removal included, so the machine that installed a sandbox can
// clean it up again. Nothing beyond the containers is granted: that is the line this test holds.
test("setup grants the fleet and nothing that reaches the machine itself", () => {
    expect(SETUP_HOST_SCOPES.sandboxes).toBe("on");
    for (const scope of ["shell", "write", "screen", "control", "destructive"] as const) {
        expect(SETUP_HOST_SCOPES[scope]).toBe("off");
    }
});

test("the seeded grant answers for every switch the card has", () => {
    const parsed = DeviceConfigSchema.parse({ platform: "linux", ...SETUP_HOST_SCOPES });
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

test("a machine named like one of the daemon's own tool servers is set apart, so its tools still mount", () => {
    expect(hostIdFrom("web")).toBe("web-device");
    expect(hostIdFrom("Code.lan")).toBe("code-device");
    expect(hostIdFrom("webby")).toBe("webby");
});

test("a machine that reports no usable name still gets one", () => {
    expect(hostIdFrom("")).toBe("this-device");
    expect(hostIdFrom("   ")).toBe("this-device");
    expect(hostIdFrom("!!!")).toBe("this-device");
});
