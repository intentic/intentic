import { HostConfigSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { hostIdFrom, SETUP_HOST_SCOPES } from "./host-seed.js";

/* THE POSTURE OF THE AUTOMATIC CONNECTION.
 *
 * Setting a sandbox up now connects the machine that ran the installer, without anyone ticking a box. That is
 * only defensible because of exactly what it grants, so what it grants is asserted here rather than left to be
 * noticed later: a person who installed a sandbox consented to running a sandbox, not to handing the agent
 * inside it a shell on their laptop.
 *
 * If a switch is ever added to the host scopes, this test fails until someone decides — deliberately — whether a
 * machine that was connected automatically should have it. That failure is the feature. */
test("a computer connected by setup may manage sandboxes and do nothing else", () => {
    expect(SETUP_HOST_SCOPES).toEqual({
        shell: "off",
        write: "off",
        screen: "off",
        control: "off",
        sandboxes: "on",
        sandboxRemove: "off",
    });
});

// Removal is the one thing an automatic grant must never carry: it is irreversible, and nobody chose it.
test("setup never grants removal", () => {
    expect(SETUP_HOST_SCOPES.sandboxRemove).toBe("off");
});

/* Every switch the card knows about is decided here. A scope added to the contract and forgotten here would be
 * absent from the seeded config, and the schema's own default would quietly answer for it — which is how a
 * default nobody chose ends up on somebody's computer. */
test("the seeded grant answers for every switch the card has", () => {
    const parsed = HostConfigSchema.parse({ platform: "linux", ...SETUP_HOST_SCOPES });
    const decided = new Set(Object.keys(SETUP_HOST_SCOPES));
    for (const key of Object.keys(parsed)) {
        // `platform` names the card, `roots` is a path list rather than a permission and is meaningless with no
        // file access granted.
        if (key === "platform" || key === "roots") {
            continue;
        }
        expect(decided).toContain(key);
    }
});

test("the machine's name becomes an id the agent can address it by", () => {
    expect(hostIdFrom("Ada-Laptop")).toBe("ada-laptop");
    // The leading label only: a box calling itself ada-laptop.lan is ada-laptop here.
    expect(hostIdFrom("ada-laptop.lan")).toBe("ada-laptop");
    expect(hostIdFrom("  Ada's Desktop  ")).toBe("ada-s-desktop");
    expect(hostIdFrom("MACHINE_01")).toBe("machine-01");
});

// An unnamed card is one nobody can find again, so there is no such thing as an empty id.
test("a machine that reports no usable name still gets one", () => {
    expect(hostIdFrom("")).toBe("this-computer");
    expect(hostIdFrom("   ")).toBe("this-computer");
    expect(hostIdFrom("!!!")).toBe("this-computer");
});
