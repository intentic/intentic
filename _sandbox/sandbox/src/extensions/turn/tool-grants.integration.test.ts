import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolCallGrants, ToolCallGrantsSchema } from "@intentic/sandbox-contract/extension-protocol";
import { z } from "zod";
import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { unstubbed } from "@intentic/testing";
import { createTurnMounts, type MountTarget, type TurnHolding } from "../../agent/tools/turn-mounts.js";
import type { ExtensionHost } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { ExtensionBackend } from "../backend/backend-supervisor.js";
import { createExtensionToolsEndpoint } from "../backend/extension-mcp.js";
import { createTurnTickets, toolGrantsOf, type TurnTicket } from "./tool-grants.js";

// (2026-11-26) What an extension tool's call is told of its turn: what the turn's lease holds, read when the call is
// made, and a ticket that names this extension and lives exactly as long as the call.

// One extension on disk, `test.acme`, contributing the cli card kind `acme`.
const host = (capabilities: readonly Capability[]) => {
    const root = mkdtempSync(join(tmpdir(), "tool-grants-"));
    mkdirSync(join(root, "acme"), { recursive: true });
    writeFileSync(
        join(root, "acme", "intentic-extension.json"),
        JSON.stringify({
            publisher: "test",
            name: "acme",
            version: "1.0.0",
            engines: { intentic: "^2.0.0" },
            server: "server.js",
            contributes: {
                tools: { perCard: "acme" },
                capabilities: [
                    {
                        id: "acme",
                        kind: "cli",
                        catalog: { name: "Acme", icon: "plug", description: "Acme", category: "business" },
                        fields: [{ key: "token", label: "Token", secret: true }],
                        env: { ACME_TOKEN: "${token}" },
                        skill: "SKILL.md",
                    },
                ],
            },
        }),
    );
    return {
        workspace: { root: mkdtempSync(join(tmpdir(), "tool-grants-ws-")) },
        files: { read: readWorkspaceFile },
        capabilities: unstubbed<Services["capabilities"]>("capabilities", {
            list: async () => [...capabilities],
            get: async (id: string) => capabilities.find((entry) => entry.id === id),
        }),
        config: { extensionsDir: root, historyRoot: mkdtempSync(join(tmpdir(), "tool-grants-history-")) },
        // A browser card's sign-in and home pages, an identity's mail provider: what the sites are read from.
        accountSignInUrls: async (capability: Capability) =>
            capability.id === "chatgpt" ? ["https://chatgpt.com/auth/login", "https://chatgpt.com/"] : capability.kind === "identity" ? ["https://accounts.google.com/"] : [],
    } satisfies ExtensionHost & Pick<Services, "capabilities" | "accountSignInUrls">;
};

const billing: Capability = { id: "billing", kind: "cli", config: { provider: "acme", token: "t" } };
const chatgpt: Capability = { id: "chatgpt", kind: "browser", config: { platform: "chatgpt" } };
const me: Capability = CapabilitySchema.parse({ id: "me", kind: "identity", config: { email: "me@gmail.com", openAccounts: "off" } });
const brave: Capability = CapabilitySchema.parse({ id: "brave", kind: "webext", config: { platform: "brave" } });
const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "t" } };

const holding = (granted: readonly string[], mounted: ReadonlyMap<string, MountTarget>): TurnHolding => ({ granted, mounted: () => mounted });

test("a call is told the accounts with their sites, the owner's browsers it mounted and the extension's own cards the turn holds", async () => {
    const services = host([billing, chatgpt, me, brave, github]);
    // `gone` was mounted but is no longer a capability; `github` is held but another extension's kind.
    const turn = holding(
        ["billing", "chatgpt", "me", "brave", "github", "removed"],
        new Map<string, MountTarget>([
            ["brave", { kind: "webext", id: "brave" }],
            ["gone", { kind: "webext", id: "gone" }],
        ]),
    );
    expect(await toolGrantsOf(services, "test.acme", turn)).toEqual({
        accounts: [
            { id: "chatgpt", kind: "browser", sites: ["chatgpt.com"] },
            // An identity signs in on its mail provider, widened to the operator's sign-in family.
            { id: "me", kind: "identity", sites: ["google.com", "youtube.com"] },
        ],
        browsers: ["brave"],
        cards: ["billing"],
    } satisfies ToolCallGrants);
    expect(await toolGrantsOf(services, "test.other", turn)).toMatchObject({ cards: [] });
    expect(await toolGrantsOf(services, "test.acme", undefined)).toEqual({ accounts: [], browsers: [], cards: [] });
});

test("a turn's lease tells the door what it holds, live: a released lease reaches nothing", () => {
    const mounts = createTurnMounts({ baseUrl: () => "http://127.0.0.1:8787/mcp" });
    const lease = mounts.lease("conv-a", { granted: ["chatgpt", "brave"] });
    const token = lease.open({ name: "brave", target: { kind: "webext", id: "brave" } }).token ?? "";
    const reach = mounts.resolve(token, "brave");
    const turn = "refused" in reach ? undefined : reach.turn;
    expect(turn?.granted).toEqual(["chatgpt", "brave"]);
    expect([...(turn?.mounted().keys() ?? [])]).toEqual(["brave"]);
    expect(mounts.holdingIn("conv-a")?.granted).toEqual(["chatgpt", "brave"]);
    lease.release();
    expect([...(turn?.mounted().keys() ?? [])]).toEqual([]);
    expect(mounts.holdingIn("conv-a")).toBeUndefined();
});

test("a ticket reads as what it was minted for until it is released, and another value reads as nothing", () => {
    const tickets = createTurnTickets();
    const standing: TurnTicket = { extension: "test.acme", conversationId: "conv-a", grants: { accounts: [], browsers: ["brave"], cards: [] }, turn: undefined };
    const minted = tickets.mint(standing);
    expect(tickets.read(minted.ticket)).toBe(standing);
    expect(tickets.read(`${minted.ticket}x`)).toBeUndefined();
    minted.release();
    expect(tickets.read(minted.ticket)).toBeUndefined();
});

const SentSchema = z.object({ turn: z.object({ ticket: z.string(), grants: ToolCallGrantsSchema }).optional() });

// A backend host's tools door that records each body it was sent, and whether its ticket read live while it answered.
const toolsHost = async (tickets: ReturnType<typeof createTurnTickets>) => {
    const seen: { readonly body: z.infer<typeof SentSchema>; readonly live: string | undefined }[] = [];
    const server: Server = createServer((req, res) => {
        let text = "";
        req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
        req.on("end", () => {
            const body = SentSchema.parse(JSON.parse(text));
            seen.push({ body, live: body.turn === undefined ? undefined : tickets.read(body.turn.ticket)?.extension });
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answer: { jsonrpc: "2.0", id: 1, result: { content: [] } } }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo.
    return { server, port: (server.address() as AddressInfo).port, seen };
};

test("a tools/call carries its turn's grants and a ticket that names its extension, released once the backend answered", async () => {
    const tickets = createTurnTickets();
    const upstream = await toolsHost(tickets);
    try {
        const services = host([billing, chatgpt]);
        const endpoint = createExtensionToolsEndpoint(
            {
                ...services,
                extensionBackend: unstubbed<ExtensionBackend>("backend", {
                    proxyTarget: () => ({ port: upstream.port, hostToken: "host-token" }),
                    status: () => ({ state: "running", extensions: [] }),
                }),
                credentialGates: unstubbed<Services["credentialGates"]>("gates", { forCapability: async () => undefined }),
                credentialGrants: unstubbed<Services["credentialGrants"]>("grants", {}),
            },
            tickets,
        );
        const call = { name: "billing", conversationId: "conv-a", signal: new AbortController().signal, turn: holding(["billing", "chatgpt"], new Map()) };
        const target = { kind: "tools", extension: "test.acme", card: "billing" } as const;
        await endpoint(target, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send" } }, call);
        await endpoint(target, { jsonrpc: "2.0", id: 2, method: "tools/list" }, call);
        const [called, listed] = upstream.seen;
        expect(called?.body.turn?.grants).toEqual({ accounts: [{ id: "chatgpt", kind: "browser", sites: ["chatgpt.com"] }], browsers: [], cards: ["billing"] });
        expect(called?.live).toBe("test.acme");
        expect(tickets.read(called?.body.turn?.ticket ?? "")).toBeUndefined();
        // Listing what the card offers is no call, and stands on nothing.
        expect(listed?.body.turn).toBeUndefined();
    } finally {
        upstream.server.close();
    }
});
