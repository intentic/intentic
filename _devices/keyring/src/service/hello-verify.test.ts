import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { helloSigned } from "./hello-verify.js";

describe("a Windows Hello signature", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const challenge = randomBytes(32).toString("base64url");

    test("counts when the pinned key made it over that challenge", () => {
        const signature = sign("sha256", Buffer.from(challenge, "base64url"), privateKey).toString("base64");
        expect(helloSigned(spki, challenge, signature)).toBe(true);
    });

    test("does not count over another challenge, or from another key", () => {
        const signature = sign("sha256", Buffer.from(challenge, "base64url"), privateKey).toString("base64");
        expect(helloSigned(spki, randomBytes(32).toString("base64url"), signature)).toBe(false);
        const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
        expect(helloSigned(spki, challenge, sign("sha256", Buffer.from(challenge, "base64url"), other).toString("base64"))).toBe(false);
        expect(helloSigned("not-a-key", challenge, signature)).toBe(false);
    });
});
