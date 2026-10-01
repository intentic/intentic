import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { type Capability, CapabilitySchema, type CapabilityStatus, type CredentialGate, type Need, PersonaPowersSchema } from "@intentic/sandbox-contract";
import type { TurnStanding } from "../../conversations/actor/turn-standing.js";
import type { AskContext } from "../need-kinds.js";
import { capabilityNeed, hostOf, servesTarget } from "./capability-need.js";

// The capability ask answered for the asking turn. Three of its answers were once all "already connected, use it"
// (docs/architecture/needs.md): a connection for another site, one the persona withholds, one whose credential is
// refused. Each has a case of its own here, taken from the session that met it.

const WEBSITE: CapabilityCatalogEntry = {
    id: "website",
    name: "Browser session",
    kind: "browser",
    category: "extend",
    description: "Sign into any site; the agent acts as you.",
    fields: [
        { key: "platform", label: "", value: "website" },
        { key: "homeUrl", label: "Page to open" },
        { key: "loginUrl", label: "Sign-in page" },
        { key: "purpose", label: "What you will use it for" },
    ],
};
const KOMODO: CapabilityCatalogEntry = {
    id: "komodo",
    name: "Komodo",
    kind: "cli",
    category: "deploy",
    description: "Stacks and deployments.",
    fields: [
        { key: "provider", label: "", value: "komodo" },
        { key: "url", label: "Address" },
        { key: "apiKey", label: "API key", secret: true },
    ],
};
const DOCKER: CapabilityCatalogEntry = {
    id: "docker",
    name: "Docker",
    kind: "docker",
    category: "platform",
    description: "Run containers, its own Engine + Compose.",
    singleton: true,
    fields: [{ key: "gpu", label: "GPU access" }],
};

// Parsed by the manifest's own schema, so a fixture that stops being a connection fails here rather than passing.
const browser = (id: string, homeUrl: string): Capability => CapabilitySchema.parse({ id, kind: "browser", config: { platform: "website", homeUrl } });
const komodo = (id: string): Capability => CapabilitySchema.parse({ id, kind: "cli", config: { provider: "komodo", url: "https://komodo.acme.dev" } });
const docker = (gpu: "on" | "off"): Capability => CapabilitySchema.parse({ id: "docker", kind: "docker", config: { gpu } });

const standing = (over: Partial<TurnStanding> = {}): TurnStanding => ({
    at: 0,
    unattended: false,
    persona: undefined,
    granted: [],
    withheldByPersona: [],
    withheldByGate: [],
    fence: undefined,
    powers: PersonaPowersSchema.parse({}),
    runtime: "claude-code",
    secrets: "masked",
    ...over,
});

interface World {
    capabilities: Capability[];
    statuses: Map<string, CapabilityStatus>;
    gates: CredentialGate[];
}

const kind = (world: World) =>
    capabilityNeed({
        entries: async () => [WEBSITE, KOMODO, DOCKER],
        capabilities: async () => world.capabilities,
        status: async (capability) => world.statuses.get(capability.id) ?? { state: "active" },
        gates: async () => world.gates,
        usableNow: async (capability) => (capability.kind === "cli" ? [`KOMODO_API_KEY_${capability.id.toUpperCase()}={{secret:${capability.id}/apiKey}}`] : []),
    });

const world = (over: Partial<World> = {}): World => ({ capabilities: [], statuses: new Map(), gates: [], ...over });
const asked = (context: Partial<AskContext> = {}): AskContext => ({ conversationId: "conv-1", standing: standing(), ...context });

const needOf = (subject: Need["subject"]): Need => ({ id: "need-1", conversationId: "conv-1", subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });

describe("capability need", () => {
    it("reads a host the way a stored setting holds it, and matches a site's subdomains both ways", () => {
        expect(hostOf("https://www.GitHub.com/intentic/intentic?tab=1")).toBe("github.com");
        expect(hostOf("deploy@box.example.com:2222")).toBe("box.example.com");
        expect(servesTarget(browser("gh", "https://github.com/login"), "github.com")).toBe(true);
        expect(servesTarget(browser("gist", "https://gist.github.com"), "github.com")).toBe(true);
        expect(servesTarget(browser("ph", "https://www.producthunt.com/"), "github.com")).toBe(false);
    });

    it("refuses an entry nobody has heard of, naming where the list is", async () => {
        expect(await kind(world()).resolve({ kind: "capability", entry: "notion" }, asked())).toEqual({
            kind: "refused",
            code: "unknown_capability",
            message: 'No catalog entry or connection is named "notion": `capabilities list` names what exists.',
        });
    });

    it("refuses a credential in --set, since only a person types that, on the card", async () => {
        const answer = await kind(world()).resolve({ kind: "capability", entry: "komodo", set: { apiKey: "k" } }, asked());
        expect(answer).toMatchObject({ kind: "refused", code: "credential_field" });
    });

    it("refuses a setting the entry does not have, listing the ones it does", async () => {
        const answer = await kind(world()).resolve({ kind: "capability", entry: "website", set: { colour: "red" } }, asked());
        expect(answer).toEqual({
            kind: "refused",
            code: "unknown_field",
            message: 'Browser session has no setting named "colour". Its settings: homeUrl, loginUrl, purpose.',
        });
    });

    it("asks to connect a new one, filling in the site and the settings the agent gave", async () => {
        const answer = await kind(world()).resolve({ kind: "capability", entry: "website", target: "github.com", set: { purpose: "submit the resource form" } }, asked());
        expect(answer).toEqual({
            kind: "raise",
            title: "Connect Browser session for github.com",
            subject: {
                kind: "capability",
                entry: "website",
                name: "Browser session",
                mode: "connect",
                target: "github.com",
                prefill: { homeUrl: "https://github.com", purpose: "submit the resource form" },
            },
        });
    });

    // 2026-08-28: asked for github.com, told "Browser session is already connected as producthunt-radarsuspam, use it".
    it("asks for the site it was asked for when the only session is for another site", async () => {
        const answer = await kind(world({ capabilities: [browser("producthunt-radarsuspam", "https://www.producthunt.com/")] })).resolve(
            { kind: "capability", entry: "website", target: "github.com" },
            asked(),
        );
        expect(answer).toMatchObject({
            kind: "raise",
            subject: { mode: "connect", target: "github.com", reason: '"producthunt-radarsuspam" is connected, but not for github.com.' },
        });
    });

    // 2026-08-16: Reddit was connected for another chat's persona; the ask said "use it" to a turn that could not.
    it("asks for a grant when the connection exists but this conversation's persona leaves it out", async () => {
        const answer = await kind(world({ capabilities: [browser("reddit-radarsuspam", "https://www.reddit.com/")] })).resolve(
            { kind: "capability", entry: "reddit-radarsuspam" },
            asked({ standing: standing({ withheldByPersona: ["reddit-radarsuspam"], persona: { id: "research", name: "Research" } }) }),
        );
        expect(answer).toEqual({
            kind: "raise",
            title: 'Let this conversation use "reddit-radarsuspam"',
            subject: { kind: "grant", subject: "capability", what: "reddit-radarsuspam", label: '"reddit-radarsuspam" (Browser session)', persona: "Research" },
        });
    });

    it("asks the gate's approvers for a release when a gate holds it for the conversation, and explains a per-use gate", async () => {
        const held = world({ capabilities: [komodo("komodo")], gates: [{ subject: "komodo", kind: "capability", approvers: ["bob@acme.dev"], scope: "conversation" }] });
        const answer = await kind(held).resolve({ kind: "capability", entry: "komodo" }, asked({ standing: standing({ withheldByGate: ["komodo"] }) }));
        expect(answer).toEqual({
            kind: "raise",
            title: 'Release "komodo" to this conversation',
            subject: { kind: "release", subject: "komodo", approvers: ["bob@acme.dev"] },
        });
        held.gates = [{ subject: "komodo", kind: "capability", approvers: ["bob@acme.dev"], scope: "use" }];
        expect(await kind(held).resolve({ kind: "capability", entry: "komodo" }, asked({ standing: standing({ withheldByGate: ["komodo"] }) }))).toMatchObject({
            kind: "refused",
            code: "gated_per_use",
        });
    });

    it("says use it only when this turn really has it", async () => {
        const answer = await kind(world({ capabilities: [komodo("komodo")] })).resolve({ kind: "capability", entry: "komodo" }, asked({ standing: standing({ granted: ["komodo"] }) }));
        expect(answer).toEqual({
            kind: "met",
            message: 'Komodo is connected as "komodo" and this turn has it: use it. If its credential is being refused, ask again with --reconnect.',
        });
    });

    it("tells a turn about a connection made after it started: usable now through its references, loaded next turn", async () => {
        const answer = await kind(world({ capabilities: [komodo("komodo")] })).resolve({ kind: "capability", entry: "komodo" }, asked());
        expect(answer).toEqual({
            kind: "met",
            message:
                'Komodo is connected as "komodo", after this turn started, so its tools and skill load on your next turn. In this turn, set its variables from their references, which the sandbox fills in at execution: KOMODO_API_KEY_KOMODO={{secret:komodo/apiKey}}',
        });
    });

    // 2026-08-18: Komodo refused its key with a 401 while probing fine; the ask answered "already connected".
    it("asks for a new credential on --reconnect, and a probe that still looks fine does not meet it: the person's word does", async () => {
        const live = world({ capabilities: [komodo("komodo")] });
        const handler = kind(live);
        const answer = await handler.resolve({ kind: "capability", entry: "komodo", reconnect: true }, asked());
        expect(answer).toMatchObject({ kind: "raise", title: 'Reconnect Komodo ("komodo")', subject: { mode: "reconnect", instance: "komodo", reported: true } });
        const need = needOf(answer.kind === "raise" ? answer.subject : { kind: "secret", name: "X" });
        expect(await handler.check(need)).toBeUndefined();
        expect(await handler.answer(need, { kind: "apply" }, { email: "owner@acme.dev" })).toMatchObject({ status: "met", result: 'Komodo is connected as "komodo".' });
    });

    it("asks for a new credential when the connection is broken, with the probe's own reason", async () => {
        const broken = world({ capabilities: [komodo("komodo")], statuses: new Map([["komodo", { state: "error", detail: "401 Invalid user credentials" }]]) });
        expect(await kind(broken).resolve({ kind: "capability", entry: "komodo" }, asked())).toMatchObject({
            kind: "raise",
            subject: { mode: "reconnect", instance: "komodo", reason: "401 Invalid user credentials" },
        });
    });

    it("asks to change a connected one's setting, is met once the change is applied, and needs nothing when it already holds", async () => {
        const off = world({ capabilities: [docker("off")] });
        const answer = await kind(off).resolve({ kind: "capability", entry: "docker", set: { gpu: "on" } }, asked({ standing: standing({ granted: ["docker"] }) }));
        expect(answer).toEqual({
            kind: "raise",
            title: 'Change Docker ("docker")',
            subject: { kind: "capability", entry: "docker", name: "Docker", mode: "change", instance: "docker", changes: { gpu: "on" } },
        });
        const need = needOf(answer.kind === "raise" ? answer.subject : { kind: "secret", name: "X" });
        expect(await kind(off).check(need)).toBeUndefined();
        off.capabilities = [docker("on")];
        expect(await kind(off).check(need)).toEqual({ result: 'Docker "docker" now has the change applied.', use: [] });
        expect(await kind(off).resolve({ kind: "capability", entry: "docker", set: { gpu: "on" } }, asked({ standing: standing({ granted: ["docker"] }) }))).toMatchObject({
            kind: "met",
        });
    });

    // A Windows device's switch was applied, yet the card kept its buttons until the poll caught up and the owner pressed again.
    it("meets a change need on the person's word only when the setting holds, so the card can close with the press", async () => {
        const off = world({ capabilities: [docker("off")] });
        const need = needOf({ kind: "capability", entry: "docker", name: "Docker", mode: "change", instance: "docker", changes: { gpu: "on" } });
        expect(await kind(off).answer(need, { kind: "apply" }, { email: "owner@acme.dev" })).toEqual({ refused: 'The change is not on Docker "docker" yet: apply it again.' });
        off.capabilities = [docker("on")];
        expect(await kind(off).answer(need, { kind: "apply" }, { email: "owner@acme.dev" })).toEqual({
            status: "met",
            result: 'Docker "docker" now has the change applied.',
            use: [],
        });
    });

    it("meets a connect need once a connection for its site comes live, saying what works now and next turn", async () => {
        const later = world();
        const need = needOf({ kind: "capability", entry: "komodo", name: "Komodo", mode: "connect" });
        expect(await kind(later).check(need)).toBeUndefined();
        later.capabilities = [komodo("komodo")];
        later.statuses.set("komodo", { state: "pending", detail: "rebuild required" });
        expect(await kind(later).check(need)).toBeUndefined();
        later.statuses.set("komodo", { state: "active" });
        expect(await kind(later).check(need)).toEqual({
            result: 'Komodo is connected as "komodo".',
            use: [
                "To use it before your next turn, set its variables from their references: KOMODO_API_KEY_KOMODO={{secret:komodo/apiKey}}",
                "From your next turn its tools, variables and skill load by themselves.",
            ],
        });
    });

    it("counts two asks for the same site on one entry as one need, and another site as another", () => {
        const handler = kind(world());
        const github = { kind: "capability" as const, entry: "website", name: "Browser session", mode: "connect" as const, target: "https://github.com" };
        expect(handler.key(github)).toBe(handler.key({ ...github, target: "github.com" }));
        expect(handler.key(github)).not.toBe(handler.key({ ...github, target: "gitlab.com" }));
    });
});
