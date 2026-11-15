import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import type { TranslatorGateway } from "../../providers/translator-gateway.js";
import { recordQueries } from "./failure-queries.js";

// What the gateway made of a routed model's refusals since the request began is the latest thing it handed the loop.
describe("the translator gateway's verdict on a turn's refusal", () => {
    const OPENED = 1_000;
    const verdict = (spent: number | undefined, throttled: number | undefined) =>
        recordQueries(
            unstubbed<Services>("services", {
                translatorGateway: unstubbed<TranslatorGateway>("translatorGateway", { attributedAt: () => spent, throttledAt: () => throttled }),
            }),
            OPENED,
        ).gatewayRefused?.("gemini", "gemini-3.8-flash-high");

    test("a request that met a spent account and then throttling ones ended on the throttle", () => {
        expect(verdict(1_100, 1_200)).toBe("throttled");
    });

    test("one whose last account refused for a spent allowance ended on that", () => {
        expect(verdict(1_300, 1_200)).toBe("spent");
    });

    test("what the gateway saw before the request began is another request's", () => {
        expect(verdict(900, 1_200)).toBe("throttled");
        expect(verdict(1_100, 900)).toBe("spent");
        expect(verdict(900, 800)).toBeUndefined();
    });
});
