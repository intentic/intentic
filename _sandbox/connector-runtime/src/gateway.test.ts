import { expect, test } from "vitest";
import { deliveryErrorResponse, GatewayRefusal } from "./gateway.js";

test("delivery responses expose only deliberate refusals", () => {
    expect(deliveryErrorResponse("slack", new GatewayRefusal("no Slack app is connected"))).toBe("no Slack app is connected");

    const internal = new Error("request failed\n    at postMessage (/srv/connector/provider.ts:42:7)");
    internal.stack = `${internal.message}\n    at deliver (/srv/connector/gateway.ts:291:19)`;
    const response = deliveryErrorResponse("slack", internal);
    expect(response).toBe("the slack connector could not deliver that message");
    expect(response).not.toContain("/srv/");
});
