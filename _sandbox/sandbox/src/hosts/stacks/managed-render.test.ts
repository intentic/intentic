import type { CredentialGate } from "@intentic/sandbox-contract/schemas/secrets";
import { dotenvValue, type ManagedSpec, maskedText, type Rendered, renderManaged, type RenderSources, secretNamesOf } from "./managed-render.js";

// The daemon's fill of a managed stack's `.env` and registry logins: how a value is written so compose's dotenv reads it
// back as stored, one pass only, and each refusal, worded by name and never by value.

// Values chosen to be found if they leak anywhere: none of them is a word a sentence would hold.
const STORED = {
    DB_PASSWORD: "pw-Zq8$x'y\"z",
    API_TOKEN: "tok-Hj3kL9mN0pQ",
    REGISTRY_PAT: "ghp_regpat0000xyz",
    PEM: "-----BEGIN KEY-----\nAAAA\n-----END KEY-----\n",
    TEMPLATE: "{{deploy:sha}} {{secret:API_TOKEN}}",
} as const satisfies Readonly<Record<string, string>>;

const sources = (over: Partial<RenderSources> = {}, stored: Readonly<Record<string, string>> = STORED): RenderSources => ({
    own: async (name) => stored[name],
    heldElsewhere: async () => undefined,
    gates: async () => [],
    ...over,
});

const stack = (input: Partial<ManagedSpec>): ManagedSpec => ({ env: {}, registries: [], ...input });

const okOf = (rendered: Rendered) => {
    if (!rendered.ok) {
        throw new Error(`expected a render, got: ${rendered.error}`);
    }
    return rendered;
};
const refusalOf = (rendered: Rendered): string => {
    if (rendered.ok) {
        throw new Error("expected a refusal, got a render");
    }
    return rendered.error;
};

test("a plain value goes bare, one with spaces, $ or lines goes in single quotes, and one with a ' in double quotes", () => {
    expect(dotenvValue("")).toBe("");
    expect(dotenvValue("postgres://db:5432/app")).toBe("postgres://db:5432/app");
    expect(dotenvValue("a b # not a comment")).toBe("'a b # not a comment'");
    expect(dotenvValue("cost $5 ${HOME}")).toBe("'cost $5 ${HOME}'");
    expect(dotenvValue("line one\nline two\n")).toBe("'line one\nline two\n'");
    expect(dotenvValue(`it's "quoted" \\ and $HOME`)).toBe(`"it's \\"quoted\\" \\\\ and $$HOME"`);
    expect(dotenvValue("crlf\r\nend")).toBe(`"crlf\\r\\nend"`);
    // A backslash last would make compose read the closing quote as escaped; a NUL has no line to sit on.
    expect(dotenvValue("ends in \\")).toBeUndefined();
    expect(dotenvValue("nul\0here")).toBeUndefined();
});

test("the names a stack reads are its variables' and its registry passwords', sorted and once each", () => {
    const spec = stack({
        env: { A: "{{secret:DB_PASSWORD}}", B: "x-{{secret:API_TOKEN}}-{{secret:DB_PASSWORD}}", C: "{{deploy:sha}}" },
        registries: [{ host: "ghcr.io", username: "ci", password: "{{secret:REGISTRY_PAT}}" }],
    });
    expect(secretNamesOf(spec)).toEqual(["API_TOKEN", "DB_PASSWORD", "REGISTRY_PAT"]);
});

test("a stack's env renders in the order sent, each secret filled in one pass, and anything else left as it is", async () => {
    const spec = stack({
        env: {
            IMAGE_TAG: "0123abcd",
            DB_PASSWORD: "{{secret:DB_PASSWORD}}",
            CERT: "{{secret:PEM}}",
            // A stored value holding references arrives exactly as stored: filling never reads a value again.
            NESTED: "{{secret:TEMPLATE}}",
            // Another family is the extension's to fill; one it left is passed on untouched.
            LEFT: "{{deploy:ref}}",
        },
    });
    const rendered = okOf(await renderManaged(spec, sources()));
    expect(rendered.env).toBe(
        [
            "IMAGE_TAG=0123abcd",
            `DB_PASSWORD="pw-Zq8$$x'y\\"z"`,
            "CERT='-----BEGIN KEY-----\nAAAA\n-----END KEY-----\n'",
            "NESTED='{{deploy:sha}} {{secret:API_TOKEN}}'",
            "LEFT='{{deploy:ref}}'",
            "",
        ].join("\n"),
    );
    expect(rendered.secretNames).toEqual(["DB_PASSWORD", "PEM", "TEMPLATE"]);
    expect([...rendered.values.keys()]).toEqual(["DB_PASSWORD", "PEM", "TEMPLATE"]);
    expect(rendered.registries).toEqual([]);
});

test("a stack with no env writes no .env at all", async () => {
    expect(okOf(await renderManaged(stack({}), sources())).env).toBeUndefined();
});

test("a registry's password is filled raw, and its host and user are never filled", async () => {
    const spec = stack({ registries: [{ host: "ghcr.io", username: "ci-web", password: "{{secret:REGISTRY_PAT}}" }] });
    const rendered = okOf(await renderManaged(spec, sources()));
    expect(rendered.registries).toEqual([{ host: "ghcr.io", username: "ci-web", password: STORED.REGISTRY_PAT }]);
    expect(rendered.secretNames).toEqual(["REGISTRY_PAT"]);
});

test("each way a name cannot be filled is refused by name, in words to act on, and no value is in any of them", async () => {
    const spec = stack({ env: { A: "{{secret:API_TOKEN}}", B: "{{secret:DB_PASSWORD}}", C: "{{secret:GITHUB/token}}", D: "{{secret:NOWHERE}}" } });
    const gate: CredentialGate = { subject: "DB_PASSWORD", kind: "secret", approvers: ["bob@corp.com"], scope: "use" };
    const error = refusalOf(
        await renderManaged(
            spec,
            sources({
                gates: async () => [gate],
                heldElsewhere: async (name) => (name === "GITHUB/token" ? "a connection's vault" : undefined),
            }),
        ),
    );
    expect(error).toBe(
        [
            `"DB_PASSWORD" is behind a named approver, and a deploy runs with nobody there to approve it: take the gate off in Secrets, or give the stack a secret of its own.`,
            `"GITHUB/token" is held only by a connection's vault, and a deploy fills from this sandbox's own secret store alone: store a copy here (\`secrets import GITHUB/token --stdin\`), then deploy again.`,
            `No secret named "NOWHERE" is stored in this sandbox: store it (\`secrets ask NOWHERE\`, or \`secrets import NOWHERE --stdin\`), then deploy again.`,
        ].join(" "),
    );
    for (const value of Object.values(STORED)) {
        expect(error).not.toContain(value);
    }
});

test("credential gates that cannot be read refuse rather than reading as ungated", async () => {
    const spec = stack({ env: { A: "{{secret:API_TOKEN}}" } });
    const error = refusalOf(
        await renderManaged(
            spec,
            sources({
                gates: async () => {
                    throw new Error("credential-gates.json is not JSON");
                },
            }),
        ),
    );
    expect(error).toBe("The credential gates could not be read (credential-gates.json is not JSON): nothing is filled until they can.");
});

test("a file reference, a secret outside a registry's password, and a value no .env can hold are refused by key", async () => {
    const fileRef = stack({ env: { CERT: "{{secret:PEM|file}}" } });
    expect(refusalOf(await renderManaged(fileRef, sources()))).toBe(
        "CERT reads {{secret:PEM|file}}, and a stack's .env has no file to point at: write {{secret:PEM}}, and its value is quoted into the .env with its lines.",
    );
    const sneaky = stack({ registries: [{ host: "ghcr.io", username: "{{secret:API_TOKEN}}", password: "{{secret:REGISTRY_PAT}}" }] });
    expect(refusalOf(await renderManaged(sneaky, sources()))).toBe("The login for ghcr.io names a secret outside its password: only a registry's password reads one.");
    const trailing = stack({ env: { WINDOWS_PATH: "{{secret:DIR}}" } });
    const rendered = await renderManaged(trailing, sources({}, { DIR: "C:\\stacks\\" }));
    expect(refusalOf(rendered)).toBe("WINDOWS_PATH's value ends in a backslash or holds a NUL character, which a .env cannot carry: change the value or how the stack reads it.");
    expect(refusalOf(rendered)).not.toContain("C:\\stacks\\");
});

test("what the machine printed back has every filled value put back as its reference, in each form it may take", () => {
    const values = new Map([
        ["DB_PASSWORD", "s3cr3t/with space"],
        ["SHORT", "abc"],
    ]);
    const printed = `echo s3cr3t/with space; json "s3cr3t/with space"; url s3cr3t%2Fwith%20space; abc stays`;
    expect(maskedText(printed, values)).toBe("echo {{secret:DB_PASSWORD}}; json \"{{secret:DB_PASSWORD}}\"; url {{secret:DB_PASSWORD}}; abc stays");
});
