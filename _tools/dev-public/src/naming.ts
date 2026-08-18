import { createHash } from "node:crypto";

/* WHAT A DEV PLATFORM IS CALLED ON THE HUB — two labels under the same wildcard every sandbox lives under,
 * derived once from a per-developer seed and then STABLE, because the whole point of stability is the one-time
 * Google OAuth registration: the client must list the exact origin and redirect URI, wildcards are not allowed,
 * and a hostname that moved would mean registering again.
 *
 * The shapes stay clear of everything else the hub serves: the platform mints `sandbox-<12hex>`, daemons attach
 * `port-…`/`public-…`/`preview-…` labels, and the hub itself answers at `zrok2.<zone>` — nothing starts with
 * `dev-` or `api-dev-`. The digest is private to this tool (nobody else ever derives these names), so it does
 * not import the contract's shared digest on purpose — agreement with another party is exactly what it does not
 * need. */

// The stable 12-hex id of this developer's public dev platform, digested from the locally persisted seed.
export const devPlatformId = (seed: string): string => createHash(`sha256`).update(seed).digest(`hex`).slice(0, 12);

export const webName = (id: string): string => `dev-${id}`;
export const apiName = (id: string): string => `api-dev-${id}`;

export const webOrigin = (id: string, zone: string): string => `https://${webName(id)}.${zone}`;
export const apiOrigin = (id: string, zone: string): string => `https://${apiName(id)}.${zone}`;

// The account's stable identity on the hub. `devplat-` rather than the platform's `sandbox-` prefix, so a hub
// operator reading the account list can tell a developer's platform grant from the sandboxes at a glance.
export const accountEmail = (id: string, zone: string): string => `devplat-${id}@${zone}`;
