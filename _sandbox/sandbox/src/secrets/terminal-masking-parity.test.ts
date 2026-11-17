import * as terminal from "@intentic/output-cleaners/cleaners";
import { CREDENTIAL_ISSUER_PREFIXES, CREDENTIAL_ISSUERS, maskCredentialMaterial } from "@intentic/sandbox-contract/policy/credential-material";
import { SECRET_REFERENCE } from "@intentic/sandbox-contract/schemas/needs";
import { SECRET_MASK_MIN } from "@intentic/sandbox-contract/schemas/secrets";
import { capabilitySecretsDocument } from "../capabilities/credentials/secret-vault.js";
import { keyringCopiesDocument, RELEASED_VALUES_FILE } from "./device/keyring-stores.js";
import { sandboxSecretsDocument } from "./sandbox-secrets.js";

// The terminal filter (@intentic/output-cleaners) imports only node builtins, so it keeps its own copies of what the
// contract and the daemon define. This is the one package that can import both sides; each test fails the moment a copy
// parts from what it copies.

test("the terminal's {{secret:name}} pattern is the contract's, and parses the references it writes", () => {
    expect({ source: terminal.SECRET_REFERENCE.source, flags: terminal.SECRET_REFERENCE.flags }).toEqual({
        source: SECRET_REFERENCE.source,
        flags: SECRET_REFERENCE.flags,
    });
    for (const name of ["CLOUDFLARE_API_TOKEN", "reddit/password", "deploy.key-1"]) {
        expect(SECRET_REFERENCE.exec(terminal.secretReference(name))?.[1]).toBe(name);
    }
});

test("the terminal and the contract know the same issuers, with the same bodies", () => {
    expect(terminal.CREDENTIAL_ISSUER_PREFIXES).toEqual(CREDENTIAL_ISSUER_PREFIXES);
    expect(terminal.CREDENTIAL_ISSUERS).toEqual(CREDENTIAL_ISSUERS);
});

test("the terminal reads every store the registry resolves, at the paths the daemon's own documents name", () => {
    expect(terminal.SECRET_STORES.map(({ path }) => path)).toEqual([
        sandboxSecretsDocument.path,
        capabilitySecretsDocument.path,
        keyringCopiesDocument.path,
        RELEASED_VALUES_FILE,
    ]);
    // Read as the daemon writes them: a keyring's copies and its released values are both flat name -> value files.
    expect(terminal.SECRET_STORES.slice(-2).map(({ layout, source }) => `${layout}:${source}`)).toEqual(["flat:copy", "flat:device"]);
});

test.each([
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAAMwAAAAtzc2gtZWQyNTUxOQ\n-----END OPENSSH PRIVATE KEY-----\n",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAKCAQEA\nnext line of prose",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nlQOYBF0x8bEBCAC5\n=Xy1Z\n-----END PGP PRIVATE KEY BLOCK-----",
    "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\nAAAAIGr3dHg0\nPrivate-MAC: ab12ab12\n",
])("a private key masks alike in the terminal and the tools: %s", (key) => {
    expect(terminal.redactText(key)).toBe(maskCredentialMaterial(key));
});

test("the terminal masks by value from the same length the Secrets view warns below", () => {
    expect(terminal.SECRET_VALUE_MIN).toBe(SECRET_MASK_MIN);
});
