import type { Capability } from "@intentic/sandbox-contract";
import type { ResolvedContribution } from "./contributions.js";
import { registry } from "./registry.js";

// secretField and echoConfig dispatch by `capability.kind` to the kind's own handler, since callers hold a Capability,
// not a handler. `connectors` passes through untouched even though only the cli kind reads it, to keep one signature
// for every kind.

// The config key holding this capability's secret, or undefined for no credential, an unset token, or one kept outside
// the manifest.
export const secretField = (capability: Capability, connectors: Map<string, ResolvedContribution>): string | undefined =>
    registry[capability.kind].secret?.(capability.config, connectors);

// The non-secret echo of a capability's config for the list summary (an mcp token becomes hasToken).
export const echoConfig = (capability: Capability, connectors: Map<string, ResolvedContribution>): Record<string, string | number | boolean> =>
    registry[capability.kind].echo(capability.config, connectors);
