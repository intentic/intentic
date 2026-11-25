import type { StackSpecInput } from "@intentic/sandbox-contract/schemas/deploys";
import { StackSpecSchema } from "@intentic/sandbox-contract/schemas/deploys";
import type { CredentialGate } from "@intentic/sandbox-contract/schemas/secrets";
import { dotenvValue, maskedText, type Rendered, renderStack, type RenderSources } from "./deploy-render.js";

// The daemon's render of a managed stack's `.env` and registry logins: how a value is written so compose's dotenv reads
// it back as stored, the deploy's own references, one pass only, and each refusal, worded by name and never by value.

const FACTS = { sha: "0123456789abcdef0123456789abcdef01234567", ref: "main", stack: "web" };

// Values chosen to be found if they leak anywhere: none of them is a word a sentence would hold.
const STORED = {
    DB_PASSWORD: "pw-Zq8$x'y\"z",
    API_TOKEN: "tok-91c2e7aa55",
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

const stack = (input: Omit<StackSpecInput, "name" | "device">) => StackSpecSchema.parse({ name: "web", device: "rog", ...input });

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

test("a stack's env renders in manifest order, with the deploy's own facts and each granted secret, in one pass", async () => {
    const spec = stack({
        env: {
            IMAGE_TAG: "{{deploy:sha8}}",
            RELEASE: "{{deploy:stack}}@{{deploy:ref}} {{deploy:sha}}",
            DB_PASSWORD: "{{secret:DB_PASSWORD}}",
            CERT: "{{secret:PEM}}",
            // A stored value holding references arrives exactly as stored: rendering never reads a value again.
            NESTED: "{{secret:TEMPLATE}}",
            LITERAL: "plain",
        },
    });
    const rendered = okOf(await renderStack("shop", spec, FACTS, ["DB_PASSWORD", "PEM", "TEMPLATE"], sources()));
    expect(rendered.env).toBe(
        [
            "IMAGE_TAG=01234567",
            `RELEASE='web@main ${FACTS.sha}'`,
            `DB_PASSWORD="pw-Zq8$$x'y\\"z"`,
            "CERT='-----BEGIN KEY-----\nAAAA\n-----END KEY-----\n'",
            "NESTED='{{deploy:sha}} {{secret:API_TOKEN}}'",
            "LITERAL=plain",
            "",
        ].join("\n"),
    );
    expect(rendered.secretNames).toEqual(["DB_PASSWORD", "PEM", "TEMPLATE"]);
    expect(rendered.registries).toEqual([]);
});

test("a deploy of a bare commit renders its ref empty, and a stack with no env writes no .env at all", async () => {
    const tagged = okOf(await renderStack("shop", stack({ env: { REF: "{{deploy:ref}}" } }), { sha: FACTS.sha, stack: "web" }, [], sources()));
    expect(tagged.env).toBe("REF=\n");
    const bare = okOf(await renderStack("shop", stack({}), FACTS, [], sources()));
    expect(bare.env).toBeUndefined();
});

test("a registry's password renders like a value, raw, and its host and user take the deploy's facts only", async () => {
    const spec = stack({ registries: [{ host: "ghcr.io", username: "ci-{{deploy:stack}}", password: "{{secret:REGISTRY_PAT}}" }] });
    const rendered = okOf(await renderStack("shop", spec, FACTS, ["REGISTRY_PAT"], sources()));
    expect(rendered.registries).toEqual([{ host: "ghcr.io", username: "ci-web", password: "ghp_regpat0000xyz" }]);
    expect(rendered.secretNames).toEqual(["REGISTRY_PAT"]);
});

test("each way a name cannot be rendered is refused by name, in words to act on, and no value is in any of them", async () => {
    const spec = stack({ env: { A: "{{secret:API_TOKEN}}", B: "{{secret:DB_PASSWORD}}", C: "{{secret:GITHUB/token}}", D: "{{secret:NOWHERE}}" } });
    const gate: CredentialGate = { subject: "DB_PASSWORD", kind: "secret", approvers: ["bob@corp.com"], scope: "use" };
    const error = refusalOf(
        await renderStack(
            "shop",
            spec,
            FACTS,
            ["API_TOKEN", "DB_PASSWORD"],
            sources({
                gates: async () => [gate],
                heldElsewhere: async (name) => (name === "GITHUB/token" ? "a connection's vault" : undefined),
            }),
        ),
    );
    expect(error).toBe(
        [
            `"GITHUB/token" and "NOWHERE" are not granted to "web" on "rog": only the owner lets a stack receive a secret (\`deploys grant shop web\` asks them on a card).`,
            `"DB_PASSWORD" is behind a named approver, and a deploy runs with nobody there to approve it: take the gate off in Secrets, or give the stack a secret of its own.`,
            `"GITHUB/token" is held only by a connection's vault, and a deploy renders from this sandbox's own secret store alone: store a copy here (\`secrets import GITHUB/token --stdin\`), then deploy again.`,
            `No secret named "NOWHERE" is stored in this sandbox: store it (\`secrets ask NOWHERE\`, or \`secrets import NOWHERE --stdin\`), then deploy again.`,
        ].join(" "),
    );
    for (const value of Object.values(STORED)) {
        expect(error).not.toContain(value);
    }
});

test("a grant that covers every name but the store cannot be read for gates refuses rather than reading it as ungated", async () => {
    const spec = stack({ env: { A: "{{secret:API_TOKEN}}" } });
    const error = refusalOf(
        await renderStack(
            "shop",
            spec,
            FACTS,
            ["API_TOKEN"],
            sources({
                gates: async () => {
                    throw new Error("credential-gates.json is not JSON");
                },
            }),
        ),
    );
    expect(error).toBe("The credential gates could not be read (credential-gates.json is not JSON): nothing is rendered until they can.");
});

test("a file reference, a secret outside a registry's password, and a value no .env can hold are refused by key", async () => {
    const fileRef = stack({ env: { CERT: "{{secret:PEM|file}}" } });
    expect(refusalOf(await renderStack("shop", fileRef, FACTS, [], sources()))).toBe(
        "CERT reads {{secret:PEM|file}}, and a stack's .env has no file to point at: write {{secret:PEM}}, and its value is quoted into the .env with its lines.",
    );
    const sneaky = stack({ registries: [{ host: "ghcr.io", username: "{{secret:API_TOKEN}}", password: "{{secret:REGISTRY_PAT}}" }] });
    expect(refusalOf(await renderStack("shop", sneaky, FACTS, ["REGISTRY_PAT", "API_TOKEN"], sources()))).toBe(
        "The login for ghcr.io names a secret outside its password: only a registry's password reads one.",
    );
    const trailing = stack({ env: { WINDOWS_PATH: "{{secret:DIR}}" } });
    const rendered = await renderStack("shop", trailing, FACTS, ["DIR"], sources({}, { DIR: "C:\\stacks\\" }));
    expect(refusalOf(rendered)).toBe("WINDOWS_PATH's value ends in a backslash or holds a NUL character, which a .env cannot carry: change the value or how the stack reads it.");
    expect(refusalOf(rendered)).not.toContain("C:\\stacks\\");
});

test("what the machine printed back has every rendered value put back as its reference, in each form it may take", () => {
    const values = new Map([
        ["DB_PASSWORD", "s3cr3t/with space"],
        ["SHORT", "abc"],
    ]);
    const printed = `echo s3cr3t/with space; json "s3cr3t/with space"; url s3cr3t%2Fwith%20space; abc stays`;
    expect(maskedText(printed, values)).toBe("echo {{secret:DB_PASSWORD}}; json \"{{secret:DB_PASSWORD}}\"; url {{secret:DB_PASSWORD}}; abc stays");
});
