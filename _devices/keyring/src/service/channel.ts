import { timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { z } from "zod";
import { answerRequestLine, type KeyringHandler, type ServerLog } from "../server.js";
import { type Challenge, ChallengeSchema, OpeningSchema, type Proof, ProofSchema } from "./door.js";
import { LineSocket } from "./lines.js";
import type { HelperLink } from "./remote.js";

// The protected service's side of the door (door.ts): loopback on Windows, a unix socket on Linux, every connection
// opening with the token. A request
// connection is answered like the pipe answers (server.ts); a helper connection is challenged, and only one that proves
// itself becomes the link prompts and typings go through.

const OPENING_DEADLINE_MS = 10_000;
// What server.address() says of a TCP listener; a pipe would be a string.
const ListeningSchema = z.object({ port: z.number().int().positive() });
// A helper's proof may wait on a person at Windows Hello as they sign in.
const PROOF_DEADLINE_MS = 180_000;

export interface DoorDeps {
    readonly handler: KeyringHandler;
    readonly link: HelperLink;
    readonly token: string;
    // What to ask a helper for: a Hello signature over a fresh challenge, its pid for polkit, the recovery key, or nothing
    // before setup.
    readonly challenge: () => Promise<Challenge>;
    // Whether `proof` answers `challenge`.
    readonly proven: (challenge: Challenge, proof: Proof) => Promise<boolean>;
    readonly log: ServerLog;
}

const sameToken = (given: string, token: string): boolean => {
    const a = Buffer.from(given, "utf8");
    const b = Buffer.from(token, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
};

const welcomeHelper = async (deps: DoorDeps, lines: LineSocket): Promise<void> => {
    const challenge = ChallengeSchema.parse(await deps.challenge());
    lines.send(challenge);
    const proof = await lines.nextOf(ProofSchema, PROOF_DEADLINE_MS);
    if (proof === undefined || proof.method === "declined" || !(await deps.proven(challenge, proof))) {
        lines.send({ ok: false, reason: "That did not prove a person at this computer." });
        lines.end();
        deps.log("a session helper's proof was refused");
        return;
    }
    lines.send({ ok: true });
    deps.link.attach(lines);
    deps.log("a session helper is connected");
};

// Where the door listens: a loopback port the system picks (Windows), or a unix socket at a fixed path (Linux), made
// 0600 here and opened to the one user it is for by the caller (service-run-linux.ts).
export type DoorPlace = { readonly kind: "tcp" } | { readonly kind: "unix"; readonly path: string };

export interface OpenDoor {
    readonly server: Server;
    // The port, for a loopback door.
    readonly port: number | undefined;
}

const listenOn = async (server: Server, place: DoorPlace): Promise<number | undefined> =>
    await new Promise<number | undefined>((resolve, reject) => {
        server.once("error", reject);
        const listening = (): void => {
            server.off("error", reject);
            if (place.kind === "unix") {
                resolve(undefined);
                return;
            }
            const address = ListeningSchema.safeParse(server.address());
            if (!address.success) {
                reject(new Error("the door did not open on a TCP port"));
                return;
            }
            resolve(address.data.port);
        };
        if (place.kind === "unix") {
            server.listen(place.path, listening);
        } else {
            server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, listening);
        }
    });

export const serveDoor = async (deps: DoorDeps, place: DoorPlace = { kind: "tcp" }): Promise<OpenDoor> => {
    const server = createServer((socket) => {
        const lines = new LineSocket(socket);
        void (async () => {
            const opening = await lines.nextOf(OpeningSchema, OPENING_DEADLINE_MS);
            if (opening === undefined || !sameToken(opening.door, deps.token)) {
                socket.destroy();
                return;
            }
            if (opening.as === "helper") {
                await welcomeHelper(deps, lines);
                return;
            }
            const request = await lines.next(OPENING_DEADLINE_MS);
            if (request === undefined) {
                socket.destroy();
                return;
            }
            socket.end(await answerRequestLine(deps.handler, request, deps.log));
        })();
    });
    if (place.kind === "unix") {
        // A socket left by a service that stopped: systemd runs one instance per user, so nothing live owns it.
        await rm(place.path, { force: true });
    }
    const port = await listenOn(server, place);
    if (place.kind === "unix") {
        await chmod(place.path, 0o600);
    }
    return { server, port };
};
