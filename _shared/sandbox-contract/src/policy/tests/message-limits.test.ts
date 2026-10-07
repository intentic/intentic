import { awaitsOwner } from "../../schemas/automations.js";
import { extensionGatewayUrlFile } from "../../state/workspace-state.js";
import { MESSAGE_LIMITS, messageLimitOf } from "../message-limits.js";

test("a platform's limit is found whatever case the post spelled it in", () => {
    expect(messageLimitOf("Discord")).toBe(2_000);
    expect(messageLimitOf("TELEGRAM")).toBe(4_096);
    expect(messageLimitOf("whatsapp")).toBe(MESSAGE_LIMITS.whatsapp);
    expect(MESSAGE_LIMITS.whatsapp).toBe(65_536);
});

test("an unknown platform has no limit, and neither does a name only an object prototype answers to", () => {
    expect(messageLimitOf("myspace")).toBeUndefined();
    // A plain record lookup answered these with Object.prototype's own members, a function where a number belongs.
    expect(messageLimitOf("constructor")).toBeUndefined();
    expect(messageLimitOf("toString")).toBeUndefined();
});

test("only a held wake with no countdown waits on the owner", () => {
    expect(awaitsOwner({})).toBe(true);
    expect(awaitsOwner({ autoRunAt: 1_700_000_000_000 })).toBe(false);
});

test("a gateway's control address lives beside the extensions' own directories, under its provider", () => {
    expect(extensionGatewayUrlFile("whatsapp")).toBe(".intentic/local/runtime/gateways/whatsapp.url");
    expect(extensionGatewayUrlFile("../x")).toBe(".intentic/local/runtime/gateways/.._x.url");
});
