import { describe, expect, it } from "vitest";
import { callerIsEuropean, hostedRegionFor } from "./region.js";

const config = { region: `iad`, regionEu: `arn` };
const from = (country?: string): Headers => new Headers(country === undefined ? {} : { "cf-ipcountry": country });

describe(`hostedRegionFor`, () => {
    it(`keeps a European caller's machine in the EEA region`, () => {
        expect(hostedRegionFor(config, from(`PL`))).toBe(`arn`);
        expect(hostedRegionFor(config, from(`DE`))).toBe(`arn`);
        // The UK and Switzerland are outside the EEA but inside the promise.
        expect(hostedRegionFor(config, from(`GB`))).toBe(`arn`);
        expect(hostedRegionFor(config, from(`CH`))).toBe(`arn`);
    });

    it(`sends everyone else to the default region`, () => {
        expect(hostedRegionFor(config, from(`US`))).toBe(`iad`);
        expect(hostedRegionFor(config, from(`JP`))).toBe(`iad`);
    });

    it(`treats an unknown country as non-European rather than guessing Europe`, () => {
        // No Cloudflare in front (a self-hosted platform), and Cloudflare's own "cannot place it".
        expect(hostedRegionFor(config, from())).toBe(`iad`);
        expect(hostedRegionFor(config, from(`XX`))).toBe(`iad`);
    });

    it(`reads the header case- and whitespace-insensitively`, () => {
        expect(callerIsEuropean(from(`pl`))).toBe(true);
        expect(callerIsEuropean(from(` fr `))).toBe(true);
    });
});
