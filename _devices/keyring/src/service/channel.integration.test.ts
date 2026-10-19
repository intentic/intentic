import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { KEYRING_RESPONSES } from "../protocol.js";
import { keyringHarness } from "../testing.js";
import { serveDoor } from "./channel.js";
import { HelperCallSchema } from "./door.js";
import { LineSocket } from "./lines.js";
import { HelperLink, remotePassphrasePrompt, remoteTypist } from "./remote.js";

const PASSPHRASE = "correct horse battery staple";

const open = async (port: number | undefined): Promise<LineSocket> => {
    const socket = connect({ host: "127.0.0.1", port: port ?? 0 });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    return new LineSocket(socket);
};

describe("the protected service's door", () => {
    test("answers a request that brings the token, and nothing that does not", async () => {
        const token = randomBytes(32).toString("base64url");
        const h = keyringHarness([]);
        const { server, port } = await serveDoor({ handler: h.keyring, link: new HelperLink(), token, challenge: () => Promise.resolve({ method: "passphrase" }), proven: () => Promise.resolve(false), log: () => undefined });
        try {
            const good = await open(port);
            good.send({ door: token, as: "request" });
            good.send({ op: "state" });
            expect(await good.nextOf(KEYRING_RESPONSES.state, 5000)).toMatchObject({ ok: true, setUp: false });
            const bad = await open(port);
            bad.send({ door: randomBytes(32).toString("base64url"), as: "request" });
            expect(await bad.next(2000)).toBeUndefined();
        } finally {
            server.close();
        }
    });

    test("puts a proven helper on the link, and the service's prompts and typing go through it", async () => {
        const token = randomBytes(32).toString("base64url");
        const link = new HelperLink();
        const { server, port } = await serveDoor({
            handler: keyringHarness([]).keyring,
            link,
            token,
            challenge: () => Promise.resolve({ method: "passphrase" }),
            proven: (_challenge, proof) => Promise.resolve(proof.method === "passphrase" && proof.passphrase === PASSPHRASE),
            log: () => undefined,
        });
        try {
            const helper = await open(port);
            helper.send({ door: token, as: "helper" });
            expect(await helper.next(5000)).toBe(JSON.stringify({ method: "passphrase" }));
            helper.send({ method: "passphrase", passphrase: PASSPHRASE });
            expect(await helper.next(5000)).toBe(JSON.stringify({ ok: true }));
            // The fake helper answers each call as a person and a window would.
            void (async () => {
                for (;;) {
                    const call = await helper.nextOf(HelperCallSchema, 5000);
                    if (call === undefined) {
                        return;
                    }
                    if (call.call === "passphrase") {
                        helper.send({ id: call.id, reply: { kind: "answered", passphrase: PASSPHRASE } });
                    } else if (call.call === "inspect") {
                        helper.send({ id: call.id, reply: { ok: true, seen: { focus: { program: "mstsc.exe", path: "C:\\Windows\\System32\\mstsc.exe", field: "password" }, handle: "1/2" } } });
                    } else if (call.call === "type") {
                        helper.send({ id: call.id, reply: { ok: true } });
                    }
                }
            })();
            expect(link.ready).toBe(true);
            expect(await remotePassphrasePrompt(link)({ title: "t", message: "m" })).toEqual({ kind: "answered", passphrase: PASSPHRASE });
            const typist = remoteTypist(link);
            const seen = await typist.inspect({ kind: "window" });
            expect(seen).toMatchObject({ ok: true, seen: { focus: { program: "mstsc.exe", field: "password" } } });
            expect(seen.ok ? await typist.type({ kind: "window" }, seen.seen, "value") : undefined).toEqual({ ok: true });
            helper.end();
        } finally {
            server.close();
        }
    });

    test("turns away a helper whose proof is wrong, so no prompt or value ever reaches it", async () => {
        const token = randomBytes(32).toString("base64url");
        const link = new HelperLink();
        const { server, port } = await serveDoor({
            handler: keyringHarness([]).keyring,
            link,
            token,
            challenge: () => Promise.resolve({ method: "passphrase" }),
            proven: () => Promise.resolve(false),
            log: () => undefined,
        });
        try {
            const impostor = await open(port);
            impostor.send({ door: token, as: "helper" });
            await impostor.next(5000);
            impostor.send({ method: "passphrase", passphrase: "a guess" });
            expect(await impostor.next(5000)).toContain('"ok":false');
            expect(link.ready).toBe(false);
            expect(await remoteTypist(link).inspect({ kind: "window" })).toMatchObject({ ok: false });
        } finally {
            server.close();
        }
    });
});
