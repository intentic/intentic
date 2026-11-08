import { unstubbed } from "@intentic/testing";
import type { TranslatorGateway } from "./translator-gateway.js";

// The translator gateway as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

/** The address the fake mints for a provider: shaped like a real one, so the doors that recognise it do, and nameable. */
export const testGatewayBase = (provider: string): string => `http://127.0.0.1:7/translator-gateway/session-for-${provider}`;

// No routed request went through it, so it filed no refusal a turn's failure is read against; anything else names itself.
export const translatorGatewayFake = (): TranslatorGateway =>
    unstubbed<TranslatorGateway>("translatorGateway", { attributedAt: () => undefined, baseUrlFor: async (provider) => testGatewayBase(provider) });
