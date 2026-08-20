import { VAULTED } from "@intentic/sandbox-contract";
import type { InvariantCheck } from "../invariants/invariants.js";
import type { CapabilitiesStore } from "./capabilities-store.js";
import type { ResolvedContribution } from "./contributions.js";
import { partitionSecretValues } from "./secret-fields.js";

/* NO CREDENTIAL SITS IN THE FILE THE AGENT CAN READ.
 *
 * This one is the repository's own words. capabilities-store.ts calls the vault sweep "an invariant rather than a
 * one-time conversion", and gives the reason: the manifest is deliberately readable and deliberately editable, so
 * "a credential is in there" is a state the system can RE-ENTER at any time — an entry the agent pasted a token
 * back into with its own file tools, one restored from an export, one hand-edited in the editor.
 *
 * It is then enforced at exactly one moment: a boot step. Between two boots — which on a long-lived sandbox is
 * weeks — a credential written into that file is one ordinary `Read` away from a model's context, and nothing
 * looks again. The sweep is the fix and it already exists; what was missing is anything that notices it is due.
 *
 * The check is the sweep's own condition, asked without acting: would a sweep have work to do? It names the
 * capability and the FIELD, never the value — a diagnostic that prints the token it is complaining about has
 * copied it into the log, which is the leak it exists to close.
 */

export interface ManifestSecretDeps {
    // The RAW manifest store, undecorated. A read through the vault decorator rehydrates, which shows a properly
    // vaulted entry exactly as it shows one whose credential never left the file — the difference this must see.
    readonly manifest: CapabilitiesStore;
    readonly connectors: () => Promise<Map<string, ResolvedContribution>>;
}

export const owner = "capabilities";

export const checks = ({ manifest, connectors }: ManifestSecretDeps): readonly InvariantCheck[] => [
    {
        name: "no-credentials-in-readable-manifest",
        /* Boot as well as the sweep, and deliberately not "instead of": the boot step runs BEFORE the gate opens
         * and moves what it finds, so this reads as a check on that step having worked, not as a duplicate of it. */
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
