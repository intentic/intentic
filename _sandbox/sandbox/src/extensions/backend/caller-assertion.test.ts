import { EXTENSION_CALLER_HEADER, EXTENSION_CALLER_TTL_MS, type ExtensionCallerIdentity } from "@intentic/sandbox-contract/extension-protocol";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/protocol/headers";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { unstubbed } from "@intentic/testing";
import type { ProvenCaller } from "../../auth/auth.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../env.config.testing.js";
import { callerAtAgentDoor, mintCallerAssertion, verifyCallerAssertion } from "./caller-assertion.js";

// The assertion of who is calling an extension's backend, as an attacker would try it: forged, tampered with, replayed
// past its window, carried to another extension or minted in another sandbox, or presented by anything but the extension
// it was minted for. Each must be refused before anyone is believed.

// Two sandboxes' daemons, told apart by the id their connect token carries (tunnel-ids.ts).
const here = { config: { ...testConfig, connectToken: "ict_conn.sbx-here.secret" } };
const elsewhere = { config: { ...testConfig, connectToken: "ict_conn.sbx-other.secret" } };

const INTERN: ExtensionCallerIdentity = { kind: "person", email: "intern@example.com", tier: "collaborator", areas: ["shop"], folders: ["shop"] };
const NOW = 1_800_000_000_000;

// The roster as the authorizer reads it now: the intern is on it as a collaborator with the shop area; anyone else is
// not, and a viewer is held below POST /agent's floor.
const INTERN_ROW: ProvenCaller = { email: "intern@example.com", tier: "collaborator", areas: ["shop"], methods: ["google"] };
const roster = new Map<string, ProvenCaller>([
    ["intern@example.com", INTERN_ROW],
    ["viewer@example.com", { email: "viewer@example.com", tier: "viewer", methods: ["google"] }],
]);

// The extension tokens the daemon minted: `acme.fix`'s and `acme.other`'s.
const tokens = new Map([
    ["tok-fix", "acme.fix"],
    ["tok-other", "acme.other"],
]);

const door = (overrides: { readonly auth?: boolean } = {}) =>
    unstubbed<Pick<Services, "config" | "auth" | "extensionBackend">>("services", {
        config: here.config,
        auth:
            overrides.auth === false
                ? undefined
                : unstubbed<NonNullable<Services["auth"]>>("auth", {
                      authorizeProven: async (proof) => {
                          const person = roster.get(proof.email);
                          if (person === undefined) {
                              throw new Error("not on the roster");
                          }
                          return person;
                      },
                  }),
        extensionBackend: unstubbed<Services["extensionBackend"]>("extensionBackend", {
            verifyExtensionToken: (presented) => {
                const id = tokens.get(presented);
                return id === undefined ? undefined : { id, permissions: ["POST /agent"] };
            },
        }),
    });

const headers =
    (values: Readonly<Record<string, string>>) =>
    (name: string): string | undefined =>
        values[name];

// POST /agent's floor for a person: a collaborator drives agents, a viewer does not.
const floor = (caller: ProvenCaller): string | undefined => (caller.tier === "viewer" ? "collaborator access required" : undefined);

describe("verifyCallerAssertion", () => {
    test("believes an assertion this daemon minted for this extension, inside its window", () => {
        const assertion = mintCallerAssertion(here, "acme.fix", INTERN, ["google"], NOW);
        expect(verifyCallerAssertion(here, assertion, "acme.fix", NOW + 1_000)).toEqual({
            claim: expect.objectContaining({ extension: "acme.fix", sandbox: sandboxIdFromToken(here.config.connectToken), caller: INTERN, proof: ["google"], expiresAt: NOW + EXTENSION_CALLER_TTL_MS }),
        });
    });

    test("refuses one past its window, at the boundary exactly", () => {
        const assertion = mintCallerAssertion(here, "acme.fix", INTERN, undefined, NOW);
        expect(verifyCallerAssertion(here, assertion, "acme.fix", NOW + EXTENSION_CALLER_TTL_MS - 1)).toHaveProperty("claim");
        expect(verifyCallerAssertion(here, assertion, "acme.fix", NOW + EXTENSION_CALLER_TTL_MS)).toEqual({
            refused: "the caller assertion is outside its window: ask the person to press again",
        });
        // Minted in the future, by more than a clock's skew, is not this run's either.
        expect(verifyCallerAssertion(here, assertion, "acme.fix", NOW - 61_000)).toHaveProperty("refused");
    });

    test("refuses one minted for another extension, or in another sandbox", () => {
        const assertion = mintCallerAssertion(here, "acme.fix", INTERN, undefined, NOW);
        expect(verifyCallerAssertion(here, assertion, "acme.other", NOW)).toEqual({ refused: "the caller assertion was minted for another extension" });
        const foreign = mintCallerAssertion(elsewhere, "acme.fix", INTERN, undefined, NOW);
        expect(verifyCallerAssertion(here, foreign, "acme.fix", NOW)).toEqual({ refused: "the caller assertion was minted for another sandbox" });
    });

    test("refuses anything not signed with this daemon's key: a forged claim, a tampered one, a lengthened one, a bare one", () => {
        const assertion = mintCallerAssertion(here, "acme.fix", { kind: "panel" }, undefined, NOW);
        const [encoded = "", signature = ""] = assertion.split(".");
        const claim = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        // The panel's assertion rewritten to name the owner, keeping the panel's signature.
        const promoted = Buffer.from(JSON.stringify({ ...claim, caller: { kind: "person", email: "owner@example.com", tier: "owner" } }), "utf8").toString("base64url");
        // The window stretched by a day.
        const stretched = Buffer.from(JSON.stringify({ ...claim, expiresAt: claim.expiresAt + 86_400_000 }), "utf8").toString("base64url");
        const refused = { refused: "the caller assertion was not minted by this sandbox's daemon" };
        expect(verifyCallerAssertion(here, `${promoted}.${signature}`, "acme.fix", NOW)).toEqual(refused);
        expect(verifyCallerAssertion(here, `${stretched}.${signature}`, "acme.fix", NOW)).toEqual(refused);
        expect(verifyCallerAssertion(here, `${encoded}.${signature}x`, "acme.fix", NOW)).toEqual(refused);
        expect(verifyCallerAssertion(here, `${encoded}.${signature}.${signature}`, "acme.fix", NOW)).toEqual(refused);
        expect(verifyCallerAssertion(here, encoded, "acme.fix", NOW)).toEqual(refused);
        expect(verifyCallerAssertion(here, "", "acme.fix", NOW)).toEqual(refused);
    });
});

describe("callerAtAgentDoor", () => {
    test("a request with no assertion is left as it is", async () => {
        expect(await callerAtAgentDoor(door(), headers({ [EXTENSION_TOKEN_HEADER]: "tok-fix" }), floor, NOW)).toEqual({ kind: "none" });
    });

    test("the extension it was minted for starts the turn as that person, read from the roster now", async () => {
        const assertion = mintCallerAssertion(here, "acme.fix", INTERN, ["google"], NOW);
        const acting = await callerAtAgentDoor(door(), headers({ [EXTENSION_TOKEN_HEADER]: "tok-fix", [EXTENSION_CALLER_HEADER]: assertion }), floor, NOW);
        expect(acting).toEqual({ kind: "person", caller: INTERN_ROW });
    });

    test("an assertion without the extension's own token is refused: a panel, an agent or a person's bearer cannot present one", async () => {
        const assertion = mintCallerAssertion(here, "acme.fix", INTERN, ["google"], NOW);
        const refused = { status: 403, refused: "a caller assertion is taken only from the extension it was minted for, with its own token" } as const;
        expect(await callerAtAgentDoor(door(), headers({ [EXTENSION_CALLER_HEADER]: assertion, "x-intentic-panel": "panel-secret" }), floor, NOW)).toEqual(refused);
        expect(await callerAtAgentDoor(door(), headers({ [EXTENSION_CALLER_HEADER]: assertion, "x-intentic-agent": "agent-secret" }), floor, NOW)).toEqual(refused);
        expect(await callerAtAgentDoor(door(), headers({ [EXTENSION_CALLER_HEADER]: assertion, authorization: "Bearer someone" }), floor, NOW)).toEqual(refused);
        expect(await callerAtAgentDoor(door(), headers({ [EXTENSION_CALLER_HEADER]: assertion, [EXTENSION_TOKEN_HEADER]: "tok-forged" }), floor, NOW)).toEqual(refused);
    });

    test("another extension's token cannot carry it, and a replay past the window is refused", async () => {
        const assertion = mintCallerAssertion(here, "acme.fix", INTERN, ["google"], NOW);
        expect(await callerAtAgentDoor(door(), headers({ [EXTENSION_TOKEN_HEADER]: "tok-other", [EXTENSION_CALLER_HEADER]: assertion }), floor, NOW)).toEqual({
            status: 401,
            refused: "the caller assertion was minted for another extension",
        });
        expect(
            await callerAtAgentDoor(door(), headers({ [EXTENSION_TOKEN_HEADER]: "tok-fix", [EXTENSION_CALLER_HEADER]: assertion }), floor, NOW + EXTENSION_CALLER_TTL_MS),
        ).toEqual({ status: 401, refused: "the caller assertion is outside its window: ask the person to press again" });
    });

    test("a person no longer on the roster, or below the route's floor, starts nothing", async () => {
        const gone = mintCallerAssertion(here, "acme.fix", { kind: "person", email: "gone@example.com", tier: "owner" }, ["google"], NOW);
        expect(await callerAtAgentDoor(door(), headers({ [EXTENSION_TOKEN_HEADER]: "tok-fix", [EXTENSION_CALLER_HEADER]: gone }), floor, NOW)).toEqual({
            status: 403,
            refused: "gone@example.com no longer reaches this sandbox (not on the roster)",
        });
        // The assertion claimed collaborator; the roster says viewer now, and the roster is what counts.
        const regraded = mintCallerAssertion(here, "acme.fix", { kind: "person", email: "viewer@example.com", tier: "collaborator" }, ["google"], NOW);
        expect(await callerAtAgentDoor(door(), headers({ [EXTENSION_TOKEN_HEADER]: "tok-fix", [EXTENSION_CALLER_HEADER]: regraded }), floor, NOW)).toEqual({
            status: 403,
            refused: "collaborator access required",
        });
    });

    test("a panel's or a program's assertion leaves the turn the extension's own, never a person's", async () => {
        for (const caller of [{ kind: "panel" }, { kind: "program", id: "ct-1", label: "nightly" }, { kind: "local" }] as const) {
            const assertion = mintCallerAssertion(here, "acme.fix", caller, undefined, NOW);
            expect(await callerAtAgentDoor(door(), headers({ [EXTENSION_TOKEN_HEADER]: "tok-fix", [EXTENSION_CALLER_HEADER]: assertion }), floor, NOW)).toEqual({
                kind: "none",
            });
        }
    });

    test("with no sign-in at all, a person's assertion is refused rather than believed", async () => {
        const assertion = mintCallerAssertion(here, "acme.fix", INTERN, ["google"], NOW);
        expect(
            await callerAtAgentDoor(door({ auth: false }), headers({ [EXTENSION_TOKEN_HEADER]: "tok-fix", [EXTENSION_CALLER_HEADER]: assertion }), floor, NOW),
        ).toEqual({ status: 403, refused: "this sandbox runs without sign-in, so no person stands behind the assertion" });
    });
});
