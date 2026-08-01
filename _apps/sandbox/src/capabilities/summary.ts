import type { Capability } from "@intentic/sandbox-contract";
import type { ResolvedConnector } from "./cli/connector-registry.js";
import { registry } from "./registry.js";

/* The two questions asked of an INSTALLED capability, both answered by the kind's own handler.
 *
 * These used to be a pair of switch statements over every kind, which made a new kind three separate acts of
 * remembering: write the handler, then find the secret switch, then find the echo switch — in a file the handler
 * never opens. Both facts are about one kind and now live with its apply/status/remove, so the compiler's demand
 * that `registry` cover every kind is the only thing that has to be satisfied.
 *
 * They stay a pair of free functions because the CALLERS hold a Capability (a manifest entry), not a handler, and
 * dispatching by `kind` is exactly what the discriminated union is for. `connectors` rides through untouched: only
 * the cli kind reads it, but a per-kind signature that varied by kind would defeat the dispatch. */

// The config key holding this capability's secret, or undefined when it carries none — an unset optional token, a
// kind with no credential at all, or one whose credential is not in the manifest (a connected computer's
// enrollment token lives on /history). Drives the /secrets inventory, reveal, and setSecret.
export const secretField = (capability: Capability, connectors: Map<string, ResolvedConnector>): string | undefined =>
    registry[capability.kind].secret?.(capability.config, connectors);

// The non-secret echo of a capability's config for the list summary (an mcp token becomes hasToken).
export const echoConfig = (capability: Capability, connectors: Map<string, ResolvedConnector>): Record<string, string | number | boolean> =>
    registry[capability.kind].echo(capability.config, connectors);
