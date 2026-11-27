import type { CapabilityField } from "@intentic/extension-manifest";
import type { CapabilityKind } from "@intentic/sandbox-contract/schemas/capabilities";

// Which of a card's fields this kind of machine can offer. The GPU switch is a host feature: hosted machines cannot pass
// Docker runtime device requests through. A field declaring `hosted: true` (2026-11-27, a card's consent to its
// `sleepWatch`) means something only on a hosted machine, so it is drawn there alone.
export const capabilityFieldAvailable = (
    entry: { readonly kind: CapabilityKind; readonly fields?: readonly Pick<CapabilityField, "key" | "hosted">[] },
    key: string,
    hosted: boolean,
): boolean => {
    if (hosted && entry.kind === "docker" && key === "gpu") {
        return false;
    }
    return hosted || entry.fields?.find((field) => field.key === key)?.hosted !== true;
};
