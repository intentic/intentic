import { unstubbed } from "@intentic/testing";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import type { Services } from "../../../composition.js";

// The seams a routed turn reads to find its model (agent/run/turn/turn-routing.ts: a run role's pin, a persona's ladder, the
// provider a job with no pin opens on) for a suite that drives the real turn doors with a turn naming a run role or a
// persona, and pins nothing: settings at their defaults, no provider connected (so the turn keeps the wire's default), no
// endpoint, no persona, an empty turn ledger. A suite that pins a model builds its own settings over these.
export const unpinnedRouting = (): Pick<Services, "sandboxSettings" | "providerReadiness" | "capabilities" | "personas" | "usage"> => ({
    sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
    // SAFETY: every native provider is named, and the readiness record holds exactly those keys.
    providerReadiness: async () => Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, false])) as Awaited<ReturnType<Services["providerReadiness"]>>,
    capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
    personas: unstubbed<Services["personas"]>("personas", { get: async () => undefined, list: async () => [] }),
    usage: unstubbed<Services["usage"]>("usage", { turns: async () => [] }),
});
