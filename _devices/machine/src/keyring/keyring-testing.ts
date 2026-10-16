import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringOp, KeyringRequest } from "@intentic/keyring";
import type { KeyringState, KeyringPointer, SealedBox, SignedKeyringGrant } from "@intentic/sandbox-contract/schemas/keyring";

// A KEYRING THAT ANSWERS FROM A SCRIPT, for the relay's and the CLI's tests (this repo's testing-file convention, kept out
// of the build): a unix socket in a temp directory speaking the keyring's protocol, one JSON line in and one out, that
// records every request it was sent and answers each op from the table it was given. An op with no answer in the table
// closes the connection unanswered, which the client reads as no keyring.

export type Answers = Partial<Record<KeyringOp, (request: KeyringRequest) => object>>;

export interface FakeKeyring {
    readonly address: string;
    readonly requests: KeyringRequest[];
    readonly close: () => Promise<void>;
}

// The socket is placed where `keyringPaths(dir)` would put it, when a test passes `dir`.
export const fakeKeyring = async (answers: Answers, dir?: string): Promise<FakeKeyring> => {
    const own = dir === undefined ? await mkdtemp(join(tmpdir(), "fake-keyring-")) : undefined;
    const address = join(dir ?? own ?? tmpdir(), "keyring.sock");
    const requests: KeyringRequest[] = [];
    const server: Server = createServer((socket) => {
        let buffered = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            buffered += chunk;
            const end = buffered.indexOf("\n");
            if (end === -1) {
                return;
            }
            // SAFETY: the client under test sends what its own types say; the test reads it back as that.
            const request = JSON.parse(buffered.slice(0, end)) as KeyringRequest;
            requests.push(request);
            const answer = answers[request.op];
            if (answer === undefined) {
                socket.destroy();
                return;
            }
            socket.end(`${JSON.stringify(answer(request))}\n`);
        });
    });
    await new Promise<void>((resolve) => server.listen(address, resolve));
    return {
        address,
        requests,
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (own !== undefined) {
                await rm(own, { recursive: true, force: true });
            }
        },
    };
};

// A socket nothing listens on: what a computer without a keyring looks like.
export const NO_KEYRING = join(tmpdir(), "no-keyring-here", "keyring.sock");

// Fixtures in the contract's own forms: 32-byte keys as 43 base64url characters, a box, a grant.
export const KEY_A = "A".repeat(43);
export const KEY_B = "B".repeat(43);

export const STATE: KeyringState = {
    version: "1.400.0",
    locked: false,
    unlockedUntil: 1_900_000_000_000,
    unlock: ["passphrase"],
    keys: { seal: KEY_A, inbox: KEY_B },
    pendingInbox: 0,
};

export const POINTER: KeyringPointer = {
    name: "VPN_PASSWORD",
    mode: "each-use",
    kind: "password",
    programs: ["FortiClient.exe"],
    packages: [],
    hosts: [],
    anyField: false,
    source: "keyring",
    updatedAt: 1_800_000_000_000,
};

export const BOX: SealedBox = { v: 1, epk: KEY_A, iv: "i".repeat(16), tag: "t".repeat(22), data: "ZGF0YQ" };

export const GRANT: SignedKeyringGrant = { payload: "eyJ2IjoxfQ", sig: "s".repeat(86) };
