import { CapabilityContributionSchema } from "@intentic/extension-manifest";
import { RunnableProvidersSchema } from "../../contracts/providers.contract.js";
import { CapabilityKindSchema } from "../../schemas/capabilities.js";
import { HubCardKindSchema } from "../../schemas/connection-hub.js";
import { REACHABLE_CREDENTIAL_KINDS } from "../../schemas/members.js";
import {
    CAPABILITY_KIND_TRAITS,
    ENDPOINT_KINDS,
    isKindOf,
    isPeerKind,
    kindsWhere,
    PEER_KINDS,
    SANDBOX_BROWSER_KINDS,
    traitsOf,
} from "./capability-kinds.js";
import { MCP_SERVER_MINTING_KINDS } from "../reserved-servers.js";
import { isSignedInAccount } from "../role-capability.js";

// Sorted, so a pin reads as a list and order never decides a match.
const sorted = (kinds: Iterable<string>): string[] => [...kinds].toSorted();
const where = (test: Parameters<typeof kindsWhere>[0]): string[] => sorted(kindsWhere(test));

test("the table has one row per kind, in the enum's order", () => {
    expect(Object.keys(CAPABILITY_KIND_TRAITS)).toEqual(CapabilityKindSchema.options);
});

// Each pin is the hand-kept list the trait replaced, as it stood on 2026-11-23: a change here is a behaviour change.
test("every derived set matches the list it replaced", () => {
    expect(where((t) => t.reachable)).toEqual(
        sorted(["cli", "mcp", "browser", "identity", "ssh", "device", "phone", "webext", "plugin", "extension", "fleet", "link"]),
    );
    expect(sorted(REACHABLE_CREDENTIAL_KINDS)).toEqual(where((t) => t.reachable));
    expect(where((t) => t.signedInAccount)).toEqual(sorted(["browser", "identity", "webext"]));
    expect(where((t) => t.sandboxBrowser)).toEqual(sorted(["browser", "identity"]));
    expect(where((t) => t.credentialMount)).toEqual(sorted(["browser", "identity", "mcp"]));
    expect(where((t) => t.turnStartMount)).toEqual(sorted(["browser", "identity", "device", "webext", "phone", "mcp", "agent", "plugin"]));
    expect(where((t) => t.tunnel)).toEqual(sorted(["vpn", "exit", "netdisk"]));
    expect(where((t) => t.mintsServer)).toEqual(sorted(["mcp", "link"]));
    expect(where((t) => t.provider === "endpoint")).toEqual(sorted(["endpoint", "localmodel"]));
    expect(where((t) => t.provider === "agent")).toEqual(["agent"]);
    expect(Object.fromEntries(kindsWhere((t) => t.peer !== undefined).map((kind) => [kind, traitsOf(kind)?.peer]))).toEqual({
        device: "hosts",
        webext: "webext",
        phone: "phones",
    });
    expect(Object.fromEntries(CapabilityKindSchema.options.map((kind) => [kind, CAPABILITY_KIND_TRAITS[kind].group]))).toEqual({
        mcp: "services",
        cli: "services",
        plugin: "services",
        extension: "services",
        agent: "services",
        wallet: "services",
        identity: "accounts",
        browser: "accounts",
        webext: "accounts",
        device: "machines",
        phone: "machines",
        ssh: "machines",
        docker: "machines",
        link: "sandboxes",
        fleet: "sandboxes",
        vpn: "network",
        netdisk: "network",
        exit: "network",
        endpoint: "models",
        localmodel: "models",
    });
});

test("the readers that kept their names answer from the table", () => {
    expect(sorted(CapabilityKindSchema.options.filter(isSignedInAccount))).toEqual(where((t) => t.signedInAccount));
    // A string no kind answers to, including an inherited property name, is not an account.
    expect(isSignedInAccount("toString")).toBe(false);
    expect(isSignedInAccount("constructor")).toBe(false);
    expect(traitsOf("hasOwnProperty")).toBeUndefined();
    expect(sorted(PEER_KINDS)).toEqual(sorted(["device", "webext", "phone"]));
    expect(sorted(ENDPOINT_KINDS)).toEqual(sorted(["endpoint", "localmodel"]));
    expect(sorted(SANDBOX_BROWSER_KINDS)).toEqual(sorted(["browser", "identity"]));
    expect(isPeerKind("devices")).toBe(false);
    expect(sorted(MCP_SERVER_MINTING_KINDS)).toEqual(sorted(["mcp", "link", "device", "webext", "phone", "cli"]));
});

test("card tiles are exactly the kinds an extension may contribute", () => {
    // The union's discriminator values, as zod gathers them from its arms.
    const arms = [...(CapabilityContributionSchema._zod.propValues["kind"] ?? [])].map(String);
    expect(where((t) => t.tile === "card")).toEqual(sorted(arms));
});

test("endpoint providers are the kinds the providers route lists as endpoints", () => {
    const listed = CapabilityKindSchema.options.filter(
        (kind) => RunnableProvidersSchema.pick({ endpoints: true }).safeParse({ endpoints: [{ id: "a", label: "a", kind }] }).success,
    );
    expect(where((t) => t.provider === "endpoint")).toEqual(sorted(listed));
});

// The hub's card kinds are a wire enum kept literal; each one is a real kind and a service or a model, never something
// tied to where it was made (a machine, a disk, a link).
test("hub card kinds are real kinds that travel", () => {
    for (const kind of HubCardKindSchema.options) {
        expect(CapabilityKindSchema.options).toContain(kind);
        expect(["services", "models"]).toContain(CAPABILITY_KIND_TRAITS[kind].group);
    }
});

test("isKindOf narrows a capability by its kind", () => {
    type Card = { readonly kind: "device"; readonly id: string } | { readonly kind: "ssh"; readonly id: string };
    const cards: readonly Card[] = [
        { kind: "device", id: "a" },
        { kind: "ssh", id: "b" },
    ];
    expect(cards.filter((card) => isKindOf(card, ["device", "phone"])).map((card) => card.id)).toEqual(["a"]);
});
