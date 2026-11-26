import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { memoryMembersStore } from "../../harness/route-stores.testing.js";
import { verifyVisitor } from "./visitor-identity.js";

// The identity door's answer: who a verified Google ID token names, and whether that address is one of the sandbox's
// own people, read from the roster at the moment of asking; a token that does not verify names nobody.

const people = (owner: string | undefined, members: readonly string[]) =>
    unstubbed<Pick<Services, "ownerEmail" | "members" | "logger">>("services", {
        ownerEmail: async () => owner,
        members: memoryMembersStore(members.map((email) => ({ email, tier: "viewer" }))),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
    });

const ask = { kind: "google" as const, clientId: "site-client", idToken: "token" };

test("a verified address is a member's when the roster holds it, in any case, and a stranger's otherwise", async () => {
    const signed = (identity: { readonly email: string; readonly name?: string }) => () => async () => identity;
    expect(await verifyVisitor(people("Owner@Acme.dev", []), ask, signed({ email: "owner@acme.dev" }))).toEqual({ email: "owner@acme.dev", member: true });
    expect(await verifyVisitor(people(undefined, ["ann@acme.dev"]), ask, signed({ email: "ann@acme.dev", name: "Ann" }))).toEqual({ email: "ann@acme.dev", name: "Ann", member: true });
    expect(await verifyVisitor(people("owner@acme.dev", ["ann@acme.dev"]), ask, signed({ email: "someone@else.example" }))).toEqual({ email: "someone@else.example", member: false });
});

test("a token that does not verify for the site's client id names nobody", async () => {
    const refusing = () => async () => {
        throw new Error("audience mismatch");
    };
    expect(await verifyVisitor(people("owner@acme.dev", []), ask, refusing)).toBeUndefined();
});
