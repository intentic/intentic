import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintReachabilityGrant, verifyReachabilityGrant } from "./ingress-contract.js";
import { isOwnerTicket, mintOwnerTicket, OWNER_TICKET_TTL_MS, publicKeyPemOf, verifyOwnerTicket } from "./owner-ticket.js";

const pair = generateKeyPairSync("ed25519");
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
const NOW = 1_800_000_000_000;

describe("owner ticket", () => {
    it("round-trips the claim and expires when it says", () => {
        const ticket = mintOwnerTicket(privatePem, { sandboxId: "0123456789ab", email: "Owner@Example.com", issuedAtMs: NOW });
        expect(isOwnerTicket(ticket)).toBe(true);
        expect(verifyOwnerTicket(publicPem, ticket, NOW + 1_000)).toEqual({
            sandboxId: "0123456789ab",
            // Lowercased at mint, the way the daemon's owner store and the platform's rows spell an address.
            email: "owner@example.com",
            issuedAt: Math.floor(NOW / 1000),
            expiresAt: Math.floor((NOW + OWNER_TICKET_TTL_MS) / 1000),
        });
        expect(verifyOwnerTicket(publicPem, ticket, NOW + OWNER_TICKET_TTL_MS + 1_000)).toBeUndefined();
    });

    it("derives the public half the machine env carries from the platform's private key", () => {
        const ticket = mintOwnerTicket(privatePem, { sandboxId: "0123456789ab", email: "o@x.dev", issuedAtMs: NOW });
        expect(verifyOwnerTicket(publicKeyPemOf(privatePem), ticket, NOW)).toMatchObject({ sandboxId: "0123456789ab", email: "o@x.dev" });
    });

    it("refuses another key's signature, a tampered claim, and garbage", () => {
        const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string;
        const ticket = mintOwnerTicket(privatePem, { sandboxId: "0123456789ab", email: "o@x.dev", issuedAtMs: NOW });
        expect(verifyOwnerTicket(other, ticket, NOW)).toBeUndefined();
        const [prefix, , signature] = ticket.split(".");
        const forged = Buffer.from(JSON.stringify({ sub: "0123456789ab", email: "thief@x.dev", iat: 1, exp: 9e9 })).toString("base64url");
        expect(verifyOwnerTicket(publicPem, `${prefix}.${forged}.${signature}`, NOW)).toBeUndefined();
        expect(verifyOwnerTicket(publicPem, "not a ticket", NOW)).toBeUndefined();
        expect(isOwnerTicket("ig1.x.y")).toBe(false);
    });

    /* One key signs both the reachability grant and the owner ticket, and neither may ever pass as the other:
     * a grant is a sandbox's right to serve its hostnames, a ticket is a person's right to drive it. */
    it("is never a reachability grant, and a grant is never a ticket", () => {
        const ticket = mintOwnerTicket(privatePem, { sandboxId: "0123456789ab", email: "o@x.dev", issuedAtMs: NOW });
        const grant = mintReachabilityGrant(privatePem, "0123456789ab", NOW);
        expect(verifyReachabilityGrant(publicPem, ticket)).toBeUndefined();
        expect(verifyOwnerTicket(publicPem, grant, NOW)).toBeUndefined();
    });

    it("refuses to mint for anything but a real sandbox id and an owner", () => {
        expect(() => mintOwnerTicket(privatePem, { sandboxId: "nope", email: "o@x.dev", issuedAtMs: NOW })).toThrow();
        expect(() => mintOwnerTicket(privatePem, { sandboxId: "0123456789ab", email: "", issuedAtMs: NOW })).toThrow();
    });
});
