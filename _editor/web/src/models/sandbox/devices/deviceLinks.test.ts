import { insidePath, page } from "@intentic/sandbox-contract/app-routes";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { cardRoute, screenRoute } from "./deviceLinks";

test("a device settings fix opens the capability entry and its existing connection", () => {
    // No route is installed here, so the link is made inside the sandbox open.
    activeSandboxId.value = `a1b2c3d4e5f6`;
    expect(cardRoute({ kind: "card", label: "Open device settings", card: "linux", connection: "linked-device" })).toBe(
        insidePath(`a1b2c3d4e5f6`, page.capabilities(`linux`, { query: { edit: `linked-device` } })),
    );
});

test("a machine's screen opens on the devices view, naming the machine, the connection and the monitor when one was picked", () => {
    activeSandboxId.value = `a1b2c3d4e5f6`;
    expect(screenRoute(`ROG-PC`, `rog`)).toEqual({ path: insidePath(`a1b2c3d4e5f6`, page.devices()), query: { device: `ROG-PC`, screen: `rog` } });
    expect(screenRoute(`ROG-PC`, `rog`, `1`)).toEqual({
        path: insidePath(`a1b2c3d4e5f6`, page.devices()),
        query: { device: `ROG-PC`, screen: `rog`, monitor: `1` },
    });
});
