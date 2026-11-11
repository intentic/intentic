import { createPublicKey, verify } from "node:crypto";
import { CapabilityContributionSchema } from "@intentic/extension-manifest";
import { stashedMarker } from "@intentic/sandbox-contract/schemas/capabilities";
import type { ResolvedContribution } from "../contributions.js";
import { CertificateRequestRefusal, makeCertificateRequest } from "./certificate-request.js";
import { certificateRequestFor } from "./key-requests.js";
import { createSecretStash, StashRefusal, unstash } from "./secret-stash.js";

// A key the sandbox makes for a card whose service issues a certificate from a request: the request must be one an
// issuer accepts (signed by the key it names, its subject as asked), and the key it stands for must install only where
// it was made for.

// One DER element: its tag and where its content sits.
const element = (bytes: Buffer, at: number) => {
    const first = bytes[at + 1] ?? 0;
    if (first < 0x80) {
        return { tag: bytes[at] ?? 0, start: at + 2, end: at + 2 + first };
    }
    const count = first & 0x7f;
    const length = [...bytes.subarray(at + 2, at + 2 + count)].reduce((total, byte) => total * 256 + byte, 0);
    return { tag: bytes[at] ?? 0, start: at + 2 + count, end: at + 2 + count + length };
};

const derOf = (pem: string): Buffer => Buffer.from(pem.replace(/-----[A-Z ]+-----/gu, "").replaceAll(/\s+/gu, ""), "base64");

test(`a request is signed by the key it names, carries the subject in order, and the key never leaves in it`, async () => {
    const made = await makeCertificateRequest({ C: "pl", ST: "Małopolskie", L: "Kraków", O: "Urząd Gminy Łąka", CN: "ezd.laka.pl", OU: "" });

    expect(made.request).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE REQUEST-----\n$/u);
    expect(made.subject).toBe("C=PL, ST=Malopolskie, L=Krakow, O=Urzad Gminy Laka, CN=ezd.laka.pl");
    expect(made.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/u);
    expect(made.request).not.toContain(made.privateKey.split("\n")[1] ?? "");

    const der = derOf(made.request);
    const outer = element(der, 0);
    const info = element(der, outer.start);
    const algorithm = element(der, info.end);
    const signature = element(der, algorithm.end);
    expect([outer.tag, info.tag, algorithm.tag, signature.tag]).toEqual([0x30, 0x30, 0x30, 0x03]);
    expect(signature.end).toBe(der.length);
    const publicKey = createPublicKey(made.privateKey);
    // The request names the key it was made with, and that key's signature over the request's body checks out.
    expect(der.subarray(info.start, info.end).includes(publicKey.export({ type: "spki", format: "der" }))).toBe(true);
    expect(verify("sha256", der.subarray(outer.start, info.end), publicKey, der.subarray(signature.start + 1, signature.end))).toBe(true);
    expect(publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
});

test(`a subject an issuer would refuse is said in words, before any key is made`, async () => {
    await expect(makeCertificateRequest({ C: "Poland", O: "Urzad" })).rejects.toThrow(`C is a country's two-letter code (PL), not "Poland"`);
    await expect(makeCertificateRequest({ O: "x".repeat(65) })).rejects.toThrow(CertificateRequestRefusal);
    await expect(makeCertificateRequest({ O: "東京都庁" })).rejects.toThrow(`O holds a character a certificate request cannot carry`);
    await expect(makeCertificateRequest({ L: "Warszawa" })).rejects.toThrow(`at least a common name (CN) or an organization (O)`);
});

const registry = (): Map<string, ResolvedContribution> => {
    const spec = CapabilityContributionSchema.parse({
        id: "e-doreczenia",
        kind: "cli",
        catalog: { name: "e-Doręczenia", description: "A mailbox.", category: "communication" },
        fields: [
            { key: "organization", label: "Organization" },
            { key: "commonName", label: "Domain" },
            { key: "privateKey", label: "Key", secret: true, keyRequest: { subject: { C: "PL", O: "${organization}", CN: "${commonName}" } } },
        ],
        env: {},
        skill: "SKILL.md",
    });
    // SAFETY: the key request reads only the card; the extension's other facts are never looked at.
    const extension = { id: "e-urzad", dir: "/tmp" } as ResolvedContribution["extension"];
    return new Map([["cli:e-doreczenia", { spec, extension }]]);
};

test(`the key stands behind a token that installs it on its own card's field and nowhere else`, async () => {
    const stash = createSecretStash();
    const answer = await certificateRequestFor(registry(), stash, {
        kind: "cli",
        provider: "e-doreczenia",
        field: "privateKey",
        values: { organization: "Urzad Gminy", commonName: "ezd.example.pl" },
    });

    expect(answer.subject).toBe("C=PL, O=Urzad Gminy, CN=ezd.example.pl");
    const installed = unstash(stash, "cli", { provider: "e-doreczenia", privateKey: stashedMarker(answer.token) });
    expect(installed["privateKey"]).toMatch(/^-----BEGIN PRIVATE KEY-----/u);
    expect(() => unstash(stash, "cli", { provider: "other-card", privateKey: stashedMarker(answer.token) })).toThrow(StashRefusal);
});

test(`a field that declares no key request gets none`, async () => {
    await expect(certificateRequestFor(registry(), createSecretStash(), { kind: "cli", provider: "e-doreczenia", field: "organization", values: {} })).rejects.toThrow(
        `no card here makes a certificate request for its "organization"`,
    );
});
