import type { KeyringNativeResponse } from "@intentic/sandbox-contract/schemas/keyring-native";

// CHROME'S NATIVE MESSAGING FRAMES: each message a 4-byte length in the machine's byte order (little-endian on every
// computer Chrome runs on) and that many bytes of UTF-8 JSON, both ways. Pure.

// Chrome sends at most 64 MiB to a host; nothing the extension sends Passwords comes near a megabyte.
const NATIVE_MESSAGE_MAX = 1024 * 1024;

export const encodeNativeMessage = (message: KeyringNativeResponse): Buffer => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
};

export class NativeMessageTooLarge extends Error {
    constructor(length: number) {
        super(`a native message of ${String(length)} bytes is larger than any the extension sends`);
        this.name = "NativeMessageTooLarge";
    }
}

/** Collects bytes as they arrive and gives back each whole message's text. */
export class NativeFrames {
    #buffered = Buffer.alloc(0);

    push(chunk: Buffer): string[] {
        this.#buffered = Buffer.concat([this.#buffered, chunk]);
        const messages: string[] = [];
        while (this.#buffered.length >= 4) {
            const length = this.#buffered.readUInt32LE(0);
            if (length > NATIVE_MESSAGE_MAX) {
                throw new NativeMessageTooLarge(length);
            }
            if (this.#buffered.length < 4 + length) {
                break;
            }
            messages.push(this.#buffered.subarray(4, 4 + length).toString("utf8"));
            this.#buffered = this.#buffered.subarray(4 + length);
        }
        return messages;
    }
}
