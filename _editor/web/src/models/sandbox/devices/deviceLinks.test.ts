import { insidePath, page } from "@intentic/sandbox-contract/app-routes";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { cardRoute } from "./deviceLinks";

test("a device settings fix opens the capability entry and its existing connection", () => {
    // No route is installed here, so the link is made inside the sandbox open.
    activeSandboxId.value = `a1b2c3d4e5f6`;
    expect(cardRoute({ kind: "card", label: "Open device settings", card: "linux", connection: "linked-device" })).toBe(
        insidePath(`a1b2c3d4e5f6`, page.capabilities(`linux`, { query: { edit: `linked-device` } })),
    );
});
