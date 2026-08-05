import type { ResourceType } from "@intentic/resources";
import { OUTPUTS } from "@intentic/resources";

// A provider may only produce outputs declared for its kind in the OUTPUTS authority. (It need not
// produce all of them; a missing output that something REFERENCES is caught later at ref resolution.)
// An entry ending with ':' is a prefix pattern — any output starting with that prefix is allowed. This
// supports dynamic per-resource outputs like discord's per-app webhook keys ("appWebhook:myApp").
export const validateOutputs = (type: ResourceType, produced: Readonly<Record<string, unknown>>, id: string): void => {
    const allowed = OUTPUTS[type];
    for (const name of Object.keys(produced)) {
        const ok = allowed.some((pattern) => (pattern.endsWith(":") ? name.startsWith(pattern) : name === pattern));
        if (!ok) {
            throw new Error(`provider for "${id}" (type "${type}") produced unknown output "${name}"; allowed: [${allowed.join(", ")}]`);
        }
    }
};
