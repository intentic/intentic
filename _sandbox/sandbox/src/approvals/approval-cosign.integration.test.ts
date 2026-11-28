import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovedAction } from "@intentic/extension-api/runtime";
import { sandboxContract } from "@intentic/sandbox-contract";
import { cosignChallenge, verifyPasskeyCosign } from "@intentic/sandbox-contract/protocol/s2s/passkey-cosign";
import type { ActionApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import { unstubbed } from "@intentic/testing";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Hono } from "hono";
import { createApp } from "../app.js";
import type { AppEnv } from "../app-env.js";
import { memoryPasskeyStore } from "../auth/auth-slice.testing.js";
import type { Services } from "../composition.js";
import { testConfig } from "../env.config.testing.js";
import { approvalIn } from "../extensions/backend/backend-approvals.js";
import { BACKEND_HOST_HEADER } from "../extensions/backend/backend-host-config.js";
import { softwareAuthenticator } from "../harness/passkey-authenticator.testing.js";
import { proven } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { createS2sIdentity } from "../s2s/identity/s2s-identity.js";
import { workspacePaths } from "../workspace/workspace.js";
import { approvalStandings, spendApprovals } from "./approval-decisions.js";
import { performApprovedAction } from "./approval-performers.js";
import { approvalsExecutorFor } from "./approvals-executor.js";
import { approvalsDocument, fileApprovalsStore } from "./approvals-store.js";

// (2026-11-28) A person's yes co-signed with their passkey, end to end over the daemon's HTTP surface with sign-in on:
// the passkey request for one item, the approve that carries the assertion, the co-signature kept with the yes off the
// workspace, and the performer's door handed an `ApprovedAction.cosign` that the contract's pure verifier accepts.

const ORIGIN = "https://app.test";
const RP_ID = "app.test";
const OWNER = "owner@example.com";
const BEARER = "owner-session";
const DIGEST = "c".repeat(64);

const ownerClient = (app: Hono<AppEnv>): ContractRouterClient<typeof sandboxContract> =>
    createORPCClient(
        new OpenAPILink(sandboxContract, {
            url: "http://sandbox",
            fetch: async (request) =>
                app.request(new Request(request, { headers: { ...Object.fromEntries(request.headers), authorization: `Bearer ${BEARER}`, origin: ORIGIN } })),
        }),
    );

// The backend host's approvals door as the performer's extension answers it: the body read by the host's own parser,
// each action kept, and done.
const performerDoor = async () => {
    const handed: ApprovedAction[] = [];
    const hostToken = "host-token";
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            void (async () => {
                const parsed = await approvalIn(new Request("http://host/approvals", { method: "POST", body: Buffer.concat(chunks) }));
                if (request.headers[BACKEND_HOST_HEADER] !== hostToken || parsed === undefined || !("action" in parsed)) {
                    response.writeHead(400).end("{}");
                    return;
                }
                handed.push(parsed.action);
                response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ outcome: "done", result: "filed" }));
            })();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo, never a pipe's path.
    const { port } = server.address() as AddressInfo;
    return { handed, port, hostToken, close: () => server.close() };
};

const setup = async () => {
    const workspace = workspacePaths(mkdtempSync(join(tmpdir(), "approval-cosign-")));
    const historyRoot = mkdtempSync(join(tmpdir(), "approval-cosign-history-"));
    const extensionsDir = join(historyRoot, "extensions");
    mkdirSync(join(extensionsDir, "office"), { recursive: true });
    writeFileSync(
        join(extensionsDir, "office", "intentic-extension.json"),
        JSON.stringify({ publisher: "acme", name: "office", version: "1.0.0", engines: { intentic: "^2.60.0" }, server: "dist/server.js" }),
    );
    const approvals = fileApprovalsStore(join(workspace.root, approvalsDocument.path));
    const passkeys = memoryPasskeyStore([], false);
    const door = await performerDoor();
    const daemon = services({
        workspace,
        approvals,
        passkeys,
        config: { ...testConfig, historyRoot, extensionsDir },
        s2sIdentity: createS2sIdentity({
            keysPath: join(historyRoot, "auth", "sandbox-identity.json"),
            domainsPath: join(historyRoot, "identity-domains.json"),
            attestationsPath: join(historyRoot, "s2s", "identity-attestations.json"),
            self: () => ({ sandbox: "sbx-1", name: "Ops", host: "sbx-1.intentic.app" }),
            resolveTxt: async () => ({ kind: "missing" }),
            now: Date.now,
        }),
        extensionBackend: unstubbed<Services["extensionBackend"]>("extensionBackend", {
            // SAFETY: the performer asks only whether the host is up; the rest of the status is no part of its path.
            status: () => ({ state: "running" }) as ReturnType<Services["extensionBackend"]["status"]>,
            proxyTarget: () => ({ port: door.port, hostToken: door.hostToken }),
        }),
        auth: {
            authorize: async (bearer) => {
                if (bearer !== BEARER) {
                    throw new Error("no bearer");
                }
                return proven(OWNER, "owner");
            },
        },
    });
    const app = createApp(daemon);
    // Dated past the hold, so the executor the routes re-arm sleeps through the test.
    const item: ActionApprovalSummary = {
        id: "filing",
        kind: "action",
        summary: "File the annual report",
        instructions: "Filed by the office extension.",
        status: "proposed",
        scheduledAt: Date.now() + 10 * 60_000,
        performer: { extension: "acme.office", digest: DIGEST },
        cosign: "required",
    };
    await approvals.upsert(item);
    const authenticator = softwareAuthenticator();
    const options = await daemon.passkeyCeremonies.registrationOptions({ identity: { email: OWNER }, origin: ORIGIN });
    await daemon.passkeyCeremonies.register({
        identity: { email: OWNER },
        origin: ORIGIN,
        response: authenticator.create({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID }),
        label: "Laptop",
    });
    const close = (): void => {
        approvalsExecutorFor(daemon).stop();
        door.close();
    };
    return { daemon, app, approvals, item, authenticator, door, roots: { historyRoot, workspaceRoot: workspace.root }, close };
};

test("a yes given with a passkey keeps its co-signature, and the performer is handed one anyone can verify", async () => {
    const { daemon, app, approvals, item, authenticator, door, roots, close } = await setup();
    try {
        const owner = ownerClient(app);
        const options = await owner.approvals.passkeyOptions({ id: "filing" });
        expect(options).toEqual({
            rpId: RP_ID,
            challenge: cosignChallenge({ v: 1, sandbox: "sbx-1", item: "filing", digest: DIGEST }),
            timeout: 120_000,
            userVerification: "required",
            allowCredentials: [{ type: "public-key", id: authenticator.credentialId, transports: ["internal"] }],
            available: true,
        });

        // The filer required a passkey: a plain yes is refused, and records nothing.
        await expect(owner.approvals.upsert({ ...item, status: "approved" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
        expect(await (await approvalStandings(roots))(item)).toBe("unapproved");

        const passkey = authenticator.get({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID });
        await owner.approvals.upsert({ ...item, status: "approved", passkey });
        const approved = (await approvals.list()).approvals.find((each) => each.id === "filing");
        if (approved?.kind !== "action" || approved.performer === undefined) {
            throw new Error("the approved item is not the action it was");
        }
        // The assertion never lands in the workspace file the agent writes.
        expect(Object.keys(approved)).not.toContain("passkey");
        expect(approved).toMatchObject({ id: "filing", status: "approved", cosign: "required" });

        const yes = (await spendApprovals(roots, [approved])).get("filing");
        expect(yes?.cosign).toMatchObject({ v: 1, credentialId: authenticator.credentialId, rpId: RP_ID, label: "Laptop" });
        expect(JSON.stringify(yes?.cosign)).not.toContain(OWNER);
        if (yes === undefined) {
            throw new Error("the yes was not there to spend");
        }

        expect(await performApprovedAction(daemon, { ...approved, performer: approved.performer }, yes)).toEqual({ outcome: "done", result: "filed" });
        const [action] = door.handed;
        expect(action).toMatchObject({ id: "filing", digest: DIGEST, approver: OWNER });
        const cosign = action?.cosign;
        if (cosign === undefined) {
            throw new Error("the performer was handed no co-signature");
        }
        expect(await verifyPasskeyCosign(cosign, { sandbox: "sbx-1", item: "filing", digest: DIGEST })).toEqual({ ok: true });
        // Bound to this digest: the same co-signature says nothing of another.
        expect(await verifyPasskeyCosign(cosign, { sandbox: "sbx-1", digest: "d".repeat(64) })).toEqual({ ok: false, reason: "it approved another sandbox, item or digest" });
    } finally {
        close();
    }
});

test("only the approver's own passkey over this item's challenge co-signs it", async () => {
    const { daemon, app, item, authenticator, close } = await setup();
    try {
        const owner = ownerClient(app);
        // Another person's passkey on this sandbox answers nothing for the owner.
        const theirs = softwareAuthenticator();
        const options = await daemon.passkeyCeremonies.registrationOptions({ identity: { email: "member@example.com" }, origin: ORIGIN });
        await daemon.passkeyCeremonies.register({
            identity: { email: "member@example.com" },
            origin: ORIGIN,
            response: theirs.create({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID }),
            label: undefined,
        });
        const challenge = (await owner.approvals.passkeyOptions({ id: "filing" })).challenge;
        await expect(
            owner.approvals.upsert({ ...item, status: "approved", passkey: theirs.get({ challenge, origin: ORIGIN, rpId: RP_ID }) }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        // An assertion over any other challenge (a sign-in's, another item's) is refused.
        const elsewhere = cosignChallenge({ v: 1, sandbox: "sbx-1", item: "other", digest: DIGEST });
        await expect(
            owner.approvals.upsert({ ...item, status: "approved", passkey: authenticator.get({ challenge: elsewhere, origin: ORIGIN, rpId: RP_ID }) }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        // An item naming no performer has no digest to co-sign.
        const plain: ActionApprovalSummary = { id: "plain", kind: "action", summary: "Water the plants", instructions: "Water them.", status: "proposed" };
        await daemon.approvals.upsert(plain);
        await expect(owner.approvals.passkeyOptions({ id: "plain" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
        close();
    }
});
