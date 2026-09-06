import { expect, test } from "vitest";
import { deliveryErrorResponse, GatewayRefusal } from "./gateway.js";

test("delivery responses expose only deliberate refusals", () => {
    const refusal = "no Slack app is connected";
    expect(deliveryErrorResponse("slack", new GatewayRefusal(refusal))).toBe(refusal);

    const internal = new Error("request failed\n    at postMessage (/srv/connector/provider.ts:42:7)");
    internal.stack = `${internal.message}\n    at deliver (/srv/connector/gateway.ts:291:19)`;
    const provider = "slack";
    const response = deliveryErrorResponse(provider, internal);
    expect(response).toContain(provider);
    expect(response).not.toContain("/srv/");
    expect(response).not.toBe(internal.message);
    expect(deliveryErrorResponse("discord", internal)).not.toBe(deliveryErrorResponse(provider, internal));
});
