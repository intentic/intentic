import type { CapabilityKind } from "@intentic/sandbox-contract/schemas/capabilities";

// The GPU switch is a host feature; hosted machines cannot pass Docker runtime device requests through.
export const capabilityFieldAvailable = (entry: { readonly kind: CapabilityKind }, key: string, hosted: boolean): boolean =>
    !(hosted && entry.kind === "docker" && key === "gpu");
