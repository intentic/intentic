import { randomBytes } from "node:crypto";
import { STATE_DIR } from "@intentic/constants";
import { sandboxContract } from "@intentic/sandbox-contract";
import { e2eTier } from "@intentic/testing/e2e";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { Client as SshClient, utils as sshUtils } from "ssh2";
import { pack } from "tar-stream";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daemonUrl, dockerBuild, dockerRmi, startSandboxContainer, until } from "./e2e-harness.js";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { hasValidBase } from "./environment/environment.js";

// The Tier-2 daemon e2e: boot the REAL sandbox image (built from this repo's Dockerfile, the same artifact CI
// publishes) in loopback mode and drive its HTTP surface exactly as the browser does, asserting only what the
// in-memory app.test.ts cannot — the real container: bytes on the real /work fs, the real sshd handshake for
// desktop sync, the real entrypoint/boot, and a real `docker build` of the composed environment overlay (the
// harness plays the outside-executor role of recreate.sh). No Cloudflare, no Google, no Claude — the only
// requirement is a Docker daemon. Gated behind INTENTIC_E2E like cli.e2e.test.ts; `pnpm e2e` sets it.
//
// SANDBOX_E2E_IMAGE skips the from-source build and runs a prebuilt image instead (CI's nightly points it at
// the freshly published :latest; local debugging can point it anywhere).
// No secrets: a Docker daemon is the whole requirement, so this tier runs on every nightly rather than waiting
// on a credential. It is the one that always has something to say.
const tier = e2eTier("sandbox daemon end-to-end (real container, loopback)", { enabledBy: "INTENTIC_E2E" });

// Non-empty so syncSshHostname derives (loopback still exposes the sync surface); the zone is a reserved TLD.
const CONNECT_TOKEN = randomBytes(16).toString("base64url");
const ZONE = "e2e.invalid";

// A tiny in-memory tar (the same wire format the browser's packTar streams to /workspace/upload-archive).
const tarBuffer = async (entries: { name: string; content: string }[]): Promise<Buffer> => {
    const archive = pack();
    for (const entry of entries) {
        archive.entry({ name: entry.name }, entry.content);
    }
    archive.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of archive) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
};

describe.skipIf(!tier.runs)(tier.title, () => {
    let container: StartedTestContainer;
    let base: string;
    let client: ContractRouterClient<typeof sandboxContract>;
    const overlayTag = `intentic-e2e-overlay:${randomBytes(4).toString("hex")}`;
    let overlayBuilt = false;

    beforeAll(async () => {
        // A zone is not what makes sync work any more (the transport rides the daemon's own surface), but it is
        // what the preview/outbox hostnames derive from, so the box still boots with one.
        container = await startSandboxContainer({ CONNECT_TOKEN, ZONE });
        base = daemonUrl(container);
        client = createORPCClient(new OpenAPILink(sandboxContract, { url: base }));
    }, 1_200_000);

    afterAll(async () => {
        await container?.stop().catch(() => {});
        if (overlayBuilt) {
            await dockerRmi(overlayTag);
        }
    }, 120_000);

    // Read a file inside the container — the ground truth the HTTP responses claim to have written.
    const inContainer = async (...command: string[]): Promise<{ exitCode: number; output: string }> => {
        const { exitCode, output } = await container.exec(command);
        return { exitCode, output };
    };

    it("uploads a file to the real /work: bytes land on disk, the source mtime is preserved", async () => {
        const response = await fetch(`${base}/workspace/upload?path=notes/hello.txt&mtime=1700000000000`, { method: "POST", body: "hello e2e" });
        expect(response.status).toBe(200);

        const cat = await inContainer("cat", "/work/notes/hello.txt");
        expect(cat.exitCode).toBe(0);
        expect(cat.output).toBe("hello e2e");
        const mtime = await inContainer("stat", "-c", "%Y", "/work/notes/hello.txt");
        expect(mtime.output.trim()).toBe("1700000000");
    }, 60_000);

    it("assembles an offset-chunked upload in place (the >100MB-body path, minus the 100MB)", async () => {
        const first = await fetch(`${base}/workspace/upload?path=notes/chunked.txt`, { method: "POST", body: "hello " });
        expect(first.status).toBe(200);
        const second = await fetch(`${base}/workspace/upload?path=notes/chunked.txt&offset=6`, { method: "POST", body: "world" });
        expect(second.status).toBe(200);

        const cat = await inContainer("cat", "/work/notes/chunked.txt");
        expect(cat.output).toBe("hello world");
    }, 60_000);

    it("upload-diff reports the already-identical file as skippable and the unknown one as not", async () => {
        const response = await fetch(`${base}/workspace/upload-diff`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                files: [
                    { path: "notes/hello.txt", size: 9, mtime: 1700000000000 },
                    { path: "notes/absent.txt", size: 1, mtime: 1700000000000 },
                ],
            }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ skip: ["notes/hello.txt"] });
    }, 60_000);

    it("extracts a tar upload into /work, silently dropping control-plane entries", async () => {
        const archive = await tarBuffer([
            { name: "tree/a.txt", content: "alpha" },
            { name: "tree/sub/b.txt", content: "beta" },
            // A dotfile the tree carries: there is no write floor on former-secret paths, so it lands like any
            // other entry (workspace.routes.integration.test.ts pins the same contract in-memory).
            { name: "tree/.env", content: "SECRET=1" },
            // The control plane is the floor that remains, and skipping it is per-entry: the rest of the drop
            // still lands. A member who could post this one would own the sandbox.
            { name: `${STATE_DIR}/owner.json`, content: `{"email":"attacker@example.com"}` },
        ]);
        const response = await fetch(`${base}/workspace/upload-archive`, { method: "POST", body: new Uint8Array(archive) });
        expect(response.status).toBe(200);

        expect((await inContainer("cat", "/work/tree/a.txt")).output).toBe("alpha");
        expect((await inContainer("cat", "/work/tree/sub/b.txt")).output).toBe("beta");
        expect((await inContainer("cat", "/work/tree/.env")).output).toBe("SECRET=1");
        // Absent (loopback binds no owner) or a real record — either way it is not the one the tar carried.
        expect((await inContainer("cat", "/work/.intentic/owner.json")).output).not.toContain("attacker@example.com");
    }, 60_000);

    it("guards the upload surface: path escape 400, control-plane write 404, oversize 413, escaping tar 400", async () => {
        expect((await fetch(`${base}/workspace/upload?path=../escape.txt`, { method: "POST", body: "x" })).status).toBe(400);
        expect((await fetch(`${base}/workspace/upload?path=.intentic/owner.json`, { method: "POST", body: "x" })).status).toBe(404);
        // offset + declared length overshoots MAX_UPLOAD_BYTES (10 GiB) without sending 10 GiB.
        expect((await fetch(`${base}/workspace/upload?path=notes/big.txt&offset=${10 * 1024 ** 3}`, { method: "POST", body: "x" })).status).toBe(413);
        const escaping = await tarBuffer([{ name: "../outside.txt", content: "x" }]);
        expect((await fetch(`${base}/workspace/upload-archive`, { method: "POST", body: new Uint8Array(escaping) })).status).toBe(400);
    }, 60_000);

    it("desktop-sync pairing lifecycle: mint → enroll → real sshd handshake → takeover → revoke", async () => {
        const pair = (await (await fetch(`${base}/system/sync/pair`, { method: "POST" })).json()) as { token: string; expiresIn: number };
        expect(pair.token.length).toBeGreaterThan(20);
        expect(pair.expiresIn).toBeGreaterThan(0);

        // Enroll machine A with the pairing token (in loopback the owner gate is open, so the token itself is
        // exercised by unit tests; what only THIS suite proves is the enrolled key opening the real sshd).
        const laptop = sshUtils.generateKeyPairSync("ed25519", { comment: "e2e-laptop" });
        const enroll = await fetch(`${base}/system/authorized-key`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-pair": pair.token },
            body: JSON.stringify({ key: laptop.public }),
        });
        expect(enroll.status).toBe(200);
        // The credential the agent presents for everything it does — including the SSH transport it serves on
        // loopback. No address comes back: the sandbox is reached at the URL the agent already has.
        expect(((await enroll.json()) as { syncToken?: string }).syncToken).toBeDefined();
        expect((await inContainer("cat", "/root/.ssh/authorized_keys")).output.trim()).toBe(laptop.public.trim());

        const status = (await (await fetch(`${base}/system/sync`)).json()) as { enrolled: boolean; syncingFrom?: string; available?: boolean };
        expect(status.enrolled).toBe(true);
        expect(status.syncingFrom).toBe("e2e-laptop");
        expect(status.available).toBe(true);

        // The enrolled key really opens the container's sshd — the transport Mutagen rides.
        await new Promise<void>((resolve, reject) => {
            const connection = new SshClient();
            connection
                .on("ready", () => {
                    connection.end();
                    resolve();
                })
                .on("error", reject)
                .connect({ host: container.getHost(), port: container.getMappedPort(22), username: "root", privateKey: laptop.private });
        });

        // A second machine without takeover is refused (423 names the holder); with the takeover header it wins.
        const desktop = sshUtils.generateKeyPairSync("ed25519", { comment: "e2e-desktop" });
        const refused = await fetch(`${base}/system/authorized-key`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key: desktop.public }),
        });
        expect(refused.status).toBe(423);
        expect(((await refused.json()) as { machine?: string }).machine).toBe("e2e-laptop");
        const takeover = await fetch(`${base}/system/authorized-key`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-sync-takeover": "1" },
            body: JSON.stringify({ key: desktop.public }),
        });
        expect(takeover.status).toBe(200);
        expect((await inContainer("cat", "/root/.ssh/authorized_keys")).output.trim()).toBe(desktop.public.trim());

        // Revoke drops the key; the status flips back to un-enrolled.
        expect((await fetch(`${base}/system/authorized-key`, { method: "DELETE" })).status).toBe(200);
        const revoked = (await (await fetch(`${base}/system/sync`)).json()) as { enrolled: boolean };
        expect(revoked.enrolled).toBe(false);
    }, 120_000);

    it("automation approval hold: a webhook fire on a requireApproval automation lands in the queue, reject drops it", async () => {
        await client.automations.upsert({ id: "e2e-approval", trigger: { kind: "event" }, prompt: "noop", requireApproval: true, enabled: true });
        const { automations } = await client.automations.list();
        const token = automations.find((automation) => automation.id === "e2e-approval")?.trigger;
        expect(token?.kind).toBe("event");
        const fireToken = token?.kind === "event" ? token.token : undefined;
        expect(fireToken).toBeDefined();

        // Wrong token is refused; the real token fires and the wake is HELD, not run — the whole trigger path
        // asserted without an agent turn.
        expect((await fetch(`${base}/automations/e2e-approval/fire?token=wrong`, { method: "POST" })).status).toBe(401);
        const fired = await fetch(`${base}/automations/e2e-approval/fire?token=${fireToken}`, { method: "POST", body: `{"hello":"e2e"}` });
        expect(fired.status).toBe(200);

        const approval = await until(async () => {
            const { approvals } = await client.automations.pendingList();
            return approvals.find((held) => held.automationId === "e2e-approval");
        }, "the held approval");
        expect(approval.payload).toContain("hello");

        await client.automations.reject({ id: approval.id });
        const { approvals } = await client.automations.pendingList();
        expect(approvals.filter((held) => held.automationId === "e2e-approval")).toEqual([]);
        await client.automations.remove({ id: "e2e-approval" });
    }, 60_000);

    it("automation guard: a failing guard records the run as skipped and never wakes the agent", async () => {
        await client.automations.upsert({ id: "e2e-guard", trigger: { kind: "event" }, guard: "exit 1", prompt: "noop", enabled: true });
        const { automations } = await client.automations.list();
        const trigger = automations.find((automation) => automation.id === "e2e-guard")?.trigger;
        const fireToken = trigger?.kind === "event" ? trigger.token : undefined;

        expect((await fetch(`${base}/automations/e2e-guard/fire?token=${fireToken}`, { method: "POST" })).status).toBe(200);
        const run = await until(async () => {
            const { automations: listed } = await client.automations.list();
            return listed.find((automation) => automation.id === "e2e-guard")?.runs[0];
        }, "the skipped run");
        expect(run.outcome).toBe("skipped");

        // A disabled automation refuses to fire at all.
        await client.automations.upsert({
            id: "e2e-guard",
            trigger: { kind: "event", token: fireToken },
            guard: "exit 1",
            prompt: "noop",
            enabled: false,
        });
        expect((await fetch(`${base}/automations/e2e-guard/fire?token=${fireToken}`, { method: "POST" })).status).toBe(409);
        await client.automations.remove({ id: "e2e-guard" });
    }, 60_000);

    it("run now: a schedule automation nobody has waited for fires by hand, guard and all", async () => {
        // The whole point of Run now is a cron you would otherwise have to wait until 3 a.m. to try. Its guard
        // still runs — a by-hand fire that skipped it would prove nothing about the real one.
        await client.automations.upsert({
            id: "e2e-run-now",
            trigger: { kind: "schedule", cron: "0 3 * * *" },
            guard: "exit 1",
            prompt: "noop",
            enabled: true,
        });
        expect(await client.automations.run({ id: "e2e-run-now" })).toEqual({ ok: true });
        const skipped = await until(async () => {
            const { automations } = await client.automations.list();
            return automations.find((automation) => automation.id === "e2e-run-now")?.runs[0];
        }, "the by-hand run");
        expect(skipped.outcome).toBe("skipped");

        await client.automations.remove({ id: "e2e-run-now" });
        await expect(client.automations.run({ id: "e2e-run-now" })).rejects.toThrow();
    }, 60_000);

    it("run now: a chat listener refuses, because a by-hand fire carries none of the messages it exists to handle", async () => {
        await client.automations.upsert({
            id: "e2e-run-now-listener",
            trigger: { kind: "listener", provider: "discord" },
            prompt: "noop",
            enabled: true,
        });
        // Refused rather than run: firing this by hand could only wake an agent told to handle events and given
        // none — and that pointless turn would hold the automation against a real mention arriving behind it.
        await expect(client.automations.run({ id: "e2e-run-now-listener" })).rejects.toThrow(/real message/);
        const { automations } = await client.automations.list();
        expect(automations.find((automation) => automation.id === "e2e-run-now-listener")?.runs).toEqual([]);
        await client.automations.remove({ id: "e2e-run-now-listener" });
    }, 60_000);

    it("capability → composed overlay → a real `docker build` of it against the published base image", async () => {
        // The vpn capability carries a Dockerfile fragment + runtime directives AND supports remove (docker's
        // deliberately doesn't). The stock container carries no VPN client, so the apply reports the rebuild
        // that installs one rather than dialling — exactly the pre-rebuild path asserted below.
        const events: unknown[] = [];
        for await (const event of await client.capabilities.add({
            id: "office",
            kind: "vpn",
            config: { provider: "wireguard", config: "[Interface]\nPrivateKey = e2e\n", autoConnect: "on" },
        })) {
            events.push(event);
        }
        expect(
            events.some(
                (event) =>
                    typeof event === "object" &&
                    event !== null &&
                    "message" in event &&
                    String((event as { message: unknown }).message).includes("rebuild"),
            ),
        ).toBe(true);

        const environment = (await (await fetch(`${base}/environment`)).json()) as { approved?: { content: string; hash: string } };
        expect(environment.approved).toBeDefined();
        const approved = environment.approved as { content: string; hash: string };
        // The compose contract recreate.sh trusts: pinned base, daemon-owned fragment, runtime directives, hash.
        expect(hasValidBase(approved.content)).toBe(true);
        expect(approved.content).toContain("wireguard-tools");
        expect(approved.content).toContain("# intentic:runtime --device=/dev/net/tun");
        expect(approved.content).toContain("# intentic:runtime --cap-add=NET_ADMIN");
        expect(approved.hash).toBe(sha256Hex(approved.content));

        // The outside-executor role: the overlay must actually build against the published :stable base.
        overlayBuilt = true;
        await dockerBuild(approved.content, overlayTag);

        // Removing the last fragment-bearing capability recomposes the overlay away (stock sandbox again).
        await client.capabilities.remove({ id: "office" });
        const recomposed = (await (await fetch(`${base}/environment`)).json()) as { approved?: unknown };
        expect(recomposed.approved).toBeUndefined();
    }, 900_000);
});
