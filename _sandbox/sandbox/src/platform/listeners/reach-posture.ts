import { INGRESS_TUNNEL_PATH } from "@intentic/sandbox-contract/ingress-contract";

// How the world reaches this sandbox, decided once from config: a tunnel the front dials, a hosted machine's included, or
// loopback only. `reason` names the deciding piece, since postures are fixed in different places.

export type ReachPosture = { readonly by: "tunnel" } | { readonly by: "loopback"; readonly reason: string };

export const reachPosture = (options: { readonly url: string; readonly grant: string; readonly frontDoor: boolean }): ReachPosture => {
    if (!options.frontDoor) {
        return { by: `loopback`, reason: `this profile serves no front door for a tunnel to reach` };
    }
    if (options.url === ``) {
        return { by: `loopback`, reason: `no INGRESS_URL, so there is no edge to dial` };
    }
    if (options.grant === ``) {
        return { by: `loopback`, reason: `no SANDBOX_GRANT, so nothing proves which sandbox this is` };
    }
    return { by: `tunnel` };
};

// The door, derived rather than configured: INGRESS_URL plus the contract's path, versioned so a v2 session shape is a
// new door rather than a flag day.
export const tunnelUrl = (base: string): string => {
    const url = new URL(INGRESS_TUNNEL_PATH, base);
    url.protocol = url.protocol === `http:` ? `ws:` : `wss:`;
    return url.toString();
};
