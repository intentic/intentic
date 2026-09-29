import { cardRoute } from "./deviceLinks";

test("a device settings fix opens the capability entry and its existing connection", () => {
    expect(cardRoute({ kind: "card", label: "Open device settings", card: "linux", connection: "linked-device" })).toEqual({
        name: "capabilities",
        params: { entry: "linux" },
        query: { edit: "linked-device" },
    });
});
