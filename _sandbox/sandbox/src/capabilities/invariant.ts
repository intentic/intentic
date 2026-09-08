import { VAULTED } from "@intentic/sandbox-contract";
import type { InvariantCheck } from "../invariants/invariants.js";
import type { CapabilitiesStore } from "./capabilities-store.js";
import type { ResolvedContribution } from "./contributions.js";
import { partitionSecretValues } from "./secret-fields.js";

// No credential may sit in the manifest the agent can read; it can re-enter at any time (a pasted token, a restored
// export, a hand edit), so this asks the sweep's own condition at boot without acting on it. Names the capability and
// field, never the value, so the diagnostic itself can't leak it.

export interface ManifestSecretDeps {
    // Raw, undecorated store: a vault-decorated read would hide the difference this check needs to see.
    readonly manifest: CapabilitiesStore;
    readonly connectors: () => Promise<Map<string, ResolvedContribution>>;
}

export const owner = "capabilities";

export const checks = ({ manifest, connectors }: ManifestSecretDeps): readonly InvariantCheck[] => [
    {
        name: "no-credentials-in-readable-manifest",
        // Boot too, not instead of sweep: this checks that boot's own move-before-gate step actually worked.
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            const resolved = await connectors();
            const exposed = (await manifest.list()).flatMap((entry) => {
                const fields = Object.entries(partitionSecretValues(entry, resolved).values)
                    .filter(([, value]) => value !== VAULTED)
                    .map(([key]) => key);
                return fields.length === 0 ? [] : [`${entry.id} (${fields.join(", ")})`];
            });
            if (exposed.length > 0) {
                fail(`${exposed.length} capabilit(ies) hold a credential in the workspace manifest, readable by any turn: ${exposed.join("; ")}`);
            }
        },
    },
];
