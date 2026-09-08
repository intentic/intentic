import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCredentialOracle } from "./credential-files.js";

// Oracle answers about real files it writes to disk. `false` is the only answer that removes a permission card;
// anything uncertain must come back `undefined`.

const TOKEN = "//registry.npmjs.org/:_authToken=npm_wCq3nTvR8xLm2ZbKp7HdJyE4sUaF6gN0iQ1t\n";
const REGISTRY_ONLY = "registry=https://registry.npmjs.org/\nengine-strict=true\n";

let root: string;
let home: string | undefined;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "credential-files-"));
    home = process.env["HOME"];
});

afterEach(() => {
    // os.homedir() reads $HOME on POSIX, which is how the `~` cases below get a directory they own.
    if (home === undefined) {
        delete process.env["HOME"];
        return;
    }
    process.env["HOME"] = home;
});

describe("the answer that removes a card", () => {
    test("a credential-shaped file with nothing in it", () => {
        writeFileSync(join(root, ".npmrc"), REGISTRY_ONLY);
        expect(createCredentialOracle()(join(root, ".npmrc"))).toBe(false);
    });

    test("a file that is not there", () => {
        expect(createCredentialOracle()(join(root, ".env"))).toBe(false);
    });

    test("a relative path, against the turn's own tree", () => {
        writeFileSync(join(root, ".env"), "PORT=3000\nNODE_ENV=development\n");
        expect(createCredentialOracle(root)(".env")).toBe(false);
    });

    test("a `~` path, expanded rather than guessed at", () => {
        process.env["HOME"] = root;
        writeFileSync(join(root, ".npmrc"), REGISTRY_ONLY);
        expect(createCredentialOracle()("~/.npmrc")).toBe(false);
        expect(createCredentialOracle()("$HOME/.npmrc")).toBe(false);
    });
});

describe("the answer that keeps one", () => {
    test("a file that really does hold a credential", () => {
        writeFileSync(join(root, ".npmrc"), TOKEN);
        expect(createCredentialOracle()(join(root, ".npmrc"))).toBe(true);
    });

    test("a `~` path to one", () => {
        process.env["HOME"] = root;
        writeFileSync(join(root, ".npmrc"), TOKEN);
        expect(createCredentialOracle()("~/.npmrc")).toBe(true);
    });
});

// Every case here is undefined, not false: the class stays exactly where the classifier's pattern put it.
describe("the answer that changes nothing", () => {
    test("a path the shell has not finished with", () => {
        const oracle = createCredentialOracle(root);
        for (const path of ["/tmp/*/.env", "$CONFIG_DIR/.npmrc", "$(pwd)/.env", "/tmp/{a,b}/.env"]) {
            expect(oracle(path), path).toBeUndefined();
        }
    });

    test("a remote path, which does not exist here for the wrong reason", () => {
        const oracle = createCredentialOracle(root);
        for (const path of ["host:~/.ssh/id_rsa", "deploy@host:/home/deploy/.npmrc"]) {
            expect(oracle(path), path).toBeUndefined();
        }
    });

    test("a directory", () => {
        mkdirSync(join(root, ".ssh"));
        expect(createCredentialOracle()(join(root, ".ssh"))).toBeUndefined();
    });

    test("a relative path with no tree to resolve it against", () => {
        expect(createCredentialOracle()(".env")).toBeUndefined();
    });

    // Binary isn't judged as text, so a DER key reads as unreadable rather than as "nothing in here" (false).
    test("a file that is not text", () => {
        writeFileSync(join(root, "id_rsa"), Buffer.from([0x30, 0x82, 0x00, 0x04, 0xa1]));
        expect(createCredentialOracle()(join(root, "id_rsa"))).toBeUndefined();
    });

    test("a file too large to be one of these", () => {
        writeFileSync(join(root, ".env"), "PORT=3000\n".repeat(40_000));
        expect(createCredentialOracle()(join(root, ".env"))).toBeUndefined();
    });
});
