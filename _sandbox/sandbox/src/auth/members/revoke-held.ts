import type { Services } from "../../composition.js";

// Everything a person's browser still holds here once their grant changes or goes: live sockets, and the tickets their
// sessions minted, which would otherwise outlive the grant they were minted under. The roster routes call it on a grant
// or a removal, and the organisation's member fence when it takes a leaver off the roster (bootstrap/platform-presence.ts).
export const revokeHeld = (services: Pick<Services, "auth" | "wsTickets" | "mediaTickets">, email: string): void => {
    services.auth?.connections.revoke(email);
    services.wsTickets.revoke(email);
    services.mediaTickets.revoke(email);
};
