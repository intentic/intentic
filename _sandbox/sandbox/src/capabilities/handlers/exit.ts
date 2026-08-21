import type { CapabilityStatus, ExitConfig } from "@intentic/sandbox-contract";
import { exitDrivers } from "../../exit/exit-drivers.js";
import { exitLink, startExit, stopExit } from "../../exit/exit-links.js";
import { removeLoadedSkill, writeLoadedSkill } from "../../settings/loaded-skills.js";
import type { CapabilityHandler } from "../capability.js";
import { TUN_PRIVILEGES_FRAGMENT } from "./net-privileges.js";

/* The `exit` capability: STORE a pool to come out of (which provider, a resting country, whether it comes up
 * on boot). Everything about starting, moving and rotating lives in the exit/ subsystem behind a per-provider
 * driver, and the live surface is the /exit routes, so this handler is only the manifest's half of the story,
 * and the same path serves the operator's Status card, the agent's `geo` CLI, this apply, the browser wiring
 * and the boot restore.
 *
 * ONE FRAGMENT PER PROVIDER, not one for the kind, because the providers differ in the thing that costs the
 * user something. Tor needs a package and NOTHING ELSE: no tun device, no NET_ADMIN, no privilege disclosure
 * on the card, because it publishes a SOCKS port itself. VPN Gate and WireGuard build real tunnels and need
 * the shared tun privilege. Folding them into one fragment would charge every tor user a container privilege
 * they never use, which is exactly the kind of quiet over-ask a capability card exists to prevent.
 */

const TOR_FRAGMENT = `# exit capability (tor): the Tor client. No runtime privileges accompany this on purpose — tor publishes its
# own SOCKS port, so it needs no tun device and no NET_ADMIN, which makes a tor-only exit the cheapest and
# least privileged way to come out of another country.
RUN apt-get update && apt-get install -y --no-install-recommends tor \\
    && rm -rf /var/lib/apt/lists/*`;

const OPENVPN_FRAGMENT = `# exit capability (vpngate): the OpenVPN client. VPN Gate's public CSV hands out OpenVPN configurations and
# nothing else, so this is the client that pool requires.
RUN apt-get update && apt-get install -y --no-install-recommends openvpn \\
    && rm -rf /var/lib/apt/lists/*`;

const WIREGUARD_FRAGMENT = `# exit capability (wireguard): wg-quick, for exits pasted in as .conf files (Proton VPN's free tier, Mullvad,
# a self-hosted peer). Deliberately without openresolv: an exit's DNS= line is stripped before the tunnel comes
# up, because applying it would rewrite /etc/resolv.conf for the WHOLE container and an exit is supposed to be
# inert until something opts into it.
RUN apt-get update && apt-get install -y --no-install-recommends wireguard-tools \\
    && rm -rf /var/lib/apt/lists/*`;

const EXIT_SKILL = `---
name: geo
description: Make requests come out of another country. Use when a page, price, search result or API answer depends on where the request appears to come from, when the user asks to check something "as seen from" somewhere, or when a site is geo-blocked.
---

# Geo exits

An exit makes traffic leave from another country. It does NOT change this sandbox's own connection, and it
never can: nothing goes through an exit unless you point it there.

The command is \`geo\`, **not** \`exit\` — \`exit\` is a shell builtin and would close your shell instead. It goes
through the daemon, so what you do here is what the user sees in the UI, and vice versa.

\`\`\`sh
geo list                    # every configured exit, its state, the country asked for and the address seen
geo countries <name>        # where this one can come out, best-supplied first
geo use <name> DE           # switch country (starts it if it was down); prints the verified new address
geo rotate <name>           # a different address in the same country
geo ip <name>               # what the world sees through it right now
geo proxy <name>            # the proxy URL, for curl and anything reading ALL_PROXY
geo stop <name>
\`\`\`

## Using one

Nothing is proxied by default. Point a command at the exit:

\`\`\`sh
curl --proxy "$(geo proxy berlin)" https://example.com/
\`\`\`

For a browser, do NOT do it per command: an account can be BOUND to an exit by the user, and then every page
that account opens comes out there, with its clock and language set to match. If the user wants an account to
browse from a country, tell them to set the exit on that account's card rather than proxying by hand, a
browser whose address says Berlin and whose clock says New York is more conspicuous than one that never moved.

## What to expect

- **A switch is verified.** \`geo use\` checks the real address afterwards and fails if it did not land in the
  country you asked for. If it fails, the exit is stopped: it is never left running in the wrong country.
- **Tor exits are blocked by a lot of the web.** Cloudflare-fronted sites, most retail, banking and social
  platforms either block them or challenge every request. That is the destination's choice, not a broken exit.
  If a site refuses, say so; do not thrash rotating.
- **Tor bandwidth is donated by volunteers.** Fine for reading pages. Not for bulk crawling or downloads.
- **These are datacenter addresses.** A site that cares can tell. An exit does not make traffic look like an
  ordinary home connection, and nothing free does.
- **VPN Gate is mostly Japan and Korea.** For anywhere else, use a tor exit.
- **\`unavailable\` means the sandbox needs a rebuild** (the user does this from Sandbox ▸ Environment). Say so
  rather than trying to install a VPN client yourself.
`;

// A live exit mapped onto the capability grid's four states. "starting" is `pending` rather than `active` on
// purpose: an exit mid-move is not yet somewhere useful, and the grid's pending affordance already means
// "not finished".
const capabilityStatus = (state: string, detail: string | undefined): CapabilityStatus => {
    if (state === "up") {
        return { state: "active" };
    }
    if (state === "starting") {
        return { state: "pending", detail: detail ?? "starting" };
    }
    if (state === "unavailable") {
        return { state: "pending", detail: "rebuild required" };
    }
    if (state === "failed") {
        return { state: "error", ...(detail === undefined ? {} : { detail }) };
    }
    return { state: "inactive" };
};

export const exitHandler: CapabilityHandler = {
    // Only the bring-your-own arm carries a credential: the pasted confs hold private keys. tor and vpngate
    // have no account at all, which is most of why they are here.
    secret: (config) => ((config as ExitConfig).provider === "wireguard" ? "config" : undefined),
    /* An explicit allowlist, never a spread of config, so the pasted WireGuard keys cannot reach the browser by
     * being forgotten in a new field. Complete over the non-credential fields, which is the other half of that
     * bargain: secret-fields.ts vaults the complement of this echo, so a field left out here is replaced in the
     * manifest by the vault marker, and `country` is a two-letter code the marker does not satisfy, which would
     * fail CapabilitySchema on the next read and take the whole entry out of the manifest. */
    echo: (config) => {
        const exit = config as ExitConfig;
        return {
            provider: exit.provider,
            autoStart: exit.autoStart,
            ...(exit.country === undefined ? {} : { country: exit.country }),
        };
    },
    fragment: (config) => {
        const exit = config as ExitConfig;
        if (exit.provider === "tor") {
            return [TOR_FRAGMENT];
        }
        // The tunnel-building providers, each with its own client plus the tun privilege shared byte-for-byte
        // with the vpn kind (see net-privileges.ts).
        return [exit.provider === "vpngate" ? OPENVPN_FRAGMENT : WIREGUARD_FRAGMENT, TUN_PRIVILEGES_FRAGMENT];
    },
    // An exit's state is keyed by id (its state directory, its interface, its derived proxy port), and the
    // proxy port MOVES with the name, which is the one consequence worth carrying: anything pointed at the old
    // port has to be repointed. So the old exit comes down and its files go, and the re-apply brings it back
    // under the new name at the new port.
    rename: {
        carry: async (_ctx, from, _to, config) => {
            const exit = config as ExitConfig;
            await stopExit({ id: from, config: exit }).catch(() => undefined);
            await exitDrivers[exit.provider].erase(from, exit);
        },
    },
    apply: async function* (ctx, id, config) {
        const exit = config as ExitConfig;
        const entry = { id, config: exit };
        const driver = exitDrivers[exit.provider];
        // Persist first: the manifest entry is what puts the fragment into the overlay, so an add must land
        // even when the client isn't installed yet.
        await driver.write(id, exit);
        await writeLoadedSkill(ctx.files, ctx.workspace.root, "geo", EXIT_SKILL);
        // Re-applying (an edited conf, a changed country, an auto-start flip) must never leave the old one
        // running: take it down, then bring it back below if it should be up.
        await stopExit(entry).catch(() => undefined);
        if (exit.autoStart !== "on") {
            yield { kind: "log", message: `Stored ${id}. Start it from the Sandbox ▸ Status card, or ask the agent to.` };
            return;
        }
        const missing = await driver.missingTool();
        if (missing !== undefined) {
            // Pre-rebuild bootstrap: a missing client is a soft outcome, not a failed add, the overlay this
            // very add composes is what installs it.
            yield {
                kind: "log",
                message: `Stored ${id}, this sandbox doesn't carry ${missing} yet. Rebuild it from the Environment card; the exit comes up when it restarts.`,
            };
            return;
        }
        yield* startExit(entry, exit.country);
    },
    status: async (_ctx, id, config) => {
        const link = await exitLink({ id, config: config as ExitConfig });
        /* A country mismatch outranks the raw state, and this is the only place the grid can say so. An exit
         * can be genuinely up and coming out of the wrong place, if it drifted after the start that verified
         * it, and "active" would be a true statement about the tunnel and a misleading one about the sandbox. */
        if (link.state === "up" && link.country !== undefined && link.observedCountry !== undefined && link.observedCountry !== link.country) {
            return { state: "error", detail: `asked for ${link.country}, coming out of ${link.observedCountry}` };
        }
        return capabilityStatus(link.state, link.detail);
    },
    remove: async (ctx, id, config) => {
        const exit = config as ExitConfig;
        await stopExit({ id, config: exit }).catch(() => undefined);
        await exitDrivers[exit.provider].erase(id, exit);
        // The skill is shared by every exit, drop it only when this was the last one. The route removes the
        // manifest entry AFTER this handler, so `id` is still counted here.
        const exitCount = (await ctx.capabilities.list()).filter((capability) => capability.kind === "exit").length;
        if (exitCount <= 1) {
            await removeLoadedSkill(ctx.files, ctx.workspace.root, "geo");
        }
    },
};
