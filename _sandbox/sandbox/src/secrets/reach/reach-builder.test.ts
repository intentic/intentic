import { buildSandboxReach, type ReachFacts } from "./reach-builder.js";
import type { Member } from "../../auth/auth.js";

const owner = "owner@example.com";
const roster: Member[] = [
    { email: "collab@example.com", tier: "collaborator", credentials: { capabilities: ["ssh-main"], secrets: [] } },
    { email: "viewer@example.com", tier: "viewer" },
];
const facts = (reader: ReachFacts["caller"]): ReachFacts => ({
    caller: reader,
    owner,
    roster,
    sandboxId: "sbx-local",
    runsOn: { host: "workstation", os: "wsl:archlinux" },
    org: { id: "org-1", name: "Example" },
    linksOut: [
        { card: "link-answering", host: "one.example", answer: "answering", terms: { tasks: true, records: false, operate: false, approve: true } },
        { card: "link-revoked", host: "two.example", answer: "revoked" },
        { card: "link-silent", host: "three.example", answer: "silent" },
    ],
    linksIn: [{ id: "in-1", label: "Remote", sandboxId: "sbx-remote", host: "remote.example", terms: { tasks: true, records: false, operate: false, approve: false }, waiting: 0 }],
    devices: [{ card: "device-main", kind: "computer", label: "Main PC", grants: ["shell"] }],
    servers: [{ card: "ssh-main", host: "server.example", user: "deploy", admin: false }],
    fleet: "fleet-main",
    readAt: 1234,
});

test("owner sees the complete access graph and other people's allowed use", () => {
    const reach = buildSandboxReach(facts({ email: owner, tier: "owner" }));
    expect(reach).toEqual({
        self: { sandboxId: "sbx-local", runsOn: { host: "workstation", os: "wsl:archlinux" }, org: { id: "org-1", name: "Example" } },
        reader: { tier: "owner", agents: true },
        linksOut: [
            { card: "link-answering", host: "one.example", answer: "answering", terms: { tasks: true, records: false, operate: false, approve: true }, yours: true, others: 0 },
            { card: "link-revoked", host: "two.example", answer: "revoked", yours: true, others: 0 },
            { card: "link-silent", host: "three.example", answer: "silent", yours: true, others: 0 },
        ],
        linksIn: [{ id: "in-1", label: "Remote", sandboxId: "sbx-remote", host: "remote.example", terms: { tasks: true, records: false, operate: false, approve: false }, waiting: 0 }],
        devices: [{ card: "device-main", kind: "computer", label: "Main PC", grants: ["shell"], yours: true, others: 0 }],
        servers: [{ card: "ssh-main", host: "server.example", user: "deploy", admin: false, yours: true, others: 1 }],
        fleet: { yours: true, others: 0 },
        people: 2,
        readAt: 1234,
    });
});

test("collaborator sees only their own agent reach, without Full access or people counts", () => {
    const reach = buildSandboxReach(facts({ email: "collab@example.com", tier: "collaborator", agents: "run" }));
    expect(reach.self).toEqual({ sandboxId: "sbx-local", org: { id: "org-1", name: "Example" } });
    expect(reach.reader).toEqual({ tier: "collaborator", agents: true });
    expect(reach.devices[0]).toEqual({ card: "device-main", kind: "computer", label: "Main PC", grants: ["shell"], yours: false });
    expect(Object.hasOwn(reach, "linksIn")).toBe(false);
    expect(Object.hasOwn(reach, "people")).toBe(false);
    expect(reach.linksOut.map(({ answer }) => answer)).toEqual(["answering", "revoked", "silent"]);
});

test("viewer agents are off and no card is theirs", () => {
    const reach = buildSandboxReach(facts({ email: "viewer@example.com", tier: "viewer" }));
    expect(reach.reader.agents).toBe(false);
    expect([...reach.linksOut.map(({ yours }) => yours), ...reach.devices.map(({ yours }) => yours), ...reach.servers.map(({ yours }) => yours), reach.fleet?.yours]).toEqual([false, false, false, false, false, false]);
});
