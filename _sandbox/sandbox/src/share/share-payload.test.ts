import { CREDENTIAL_MASK as MASK, holdsCredentialToken, type TranscriptRow } from "@intentic/sandbox-contract";
import { sharePage } from "./share-page.js";
import { redactSecrets, shareTranscript } from "./share-payload.js";

// Pins what leaves the machine: the safety tests for a pure function whose payload is checked directly, since every
// claim the share dialog makes to a publisher is verified here.

const conversation: TranscriptRow[] = [
    {
        role: "user",
        text: "here is the key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
        sentAt: 1786372320000,
        attachments: [".intentic/records/artifacts/attachments/a1/screenshot.png"],
        notes: [{ title: "Workspace context", text: "the branch moved under you" }],
        checkpointId: "snap-1",
    },
    {
        role: "assistant",
        text: "Fixed.",
        thinking: "the guard re-runs on every hop",
        tools: [
            {
                id: "t1",
                name: "Edit",
                category: "edit",
                status: "completed",
                target: "auth/guard.ts",
                content: [
                    { type: "diff", path: "auth/guard.ts", oldText: "const KEY = 'AKIAIOSFODNN7EXAMPLE'", newText: "const KEY = process.env.KEY" },
                    { type: "image", path: ".intentic/records/artifacts/browser/after.png" },
                ],
            },
        ],
    },
];

describe("a messages-only share", () => {
    it("carries the two speakers' words and none of the agent's work", () => {
        const { messages } = shareTranscript(conversation, "messages");
        expect(messages).toHaveLength(2);
        expect(messages[1]?.text).toBe("Fixed.");
        expect(messages[1]?.tools).toBeUndefined();
        expect(messages[1]?.thinking).toBeUndefined();
        expect(JSON.stringify(messages)).not.toContain("auth/guard.ts");
    });

    // An attachment belongs to the prompt, not the agent's work, so it survives at every detail level.
    it("keeps what the user attached to their own message", () => {
        const { messages, pictures } = shareTranscript(conversation, "messages");
        expect(messages[0]?.attachments).toEqual(["files/1-screenshot.png"]);
        expect(pictures).toEqual([{ source: ".intentic/records/artifacts/attachments/a1/screenshot.png", published: "files/1-screenshot.png" }]);
    });
});

// `placed`: an owner-written line in the agent's voice must not read as the agent's to a human reader of the share page
// (the agent-facing handoff stays blind to it; see TranscriptRowSchema).
describe("a placed row", () => {
    it("keeps its mark in the shared payload", () => {
        const placed: TranscriptRow[] = [{ role: "assistant", text: "I verified it myself.", placed: true }];
        expect(shareTranscript(placed, "messages").messages[0]).toEqual({ role: "assistant", text: "I verified it myself.", placed: true });
        expect(shareTranscript(placed, "everything").messages[0]).toEqual({ role: "assistant", text: "I verified it myself.", placed: true });
    });
});

describe("an everything share", () => {
    it("carries the work: the thinking, the cards, and the diffs of what was edited", () => {
        const { messages } = shareTranscript(conversation, "everything");
        expect(messages[1]?.thinking).toBe(conversation[1]?.thinking);
        expect(messages[1]?.tools?.[0]?.target).toBe("auth/guard.ts");
        expect(messages[1]?.tools?.[0]?.content?.[0]).toMatchObject({ type: "diff", newText: "const KEY = process.env.KEY" });
    });

    it("repoints every picture at the copy that will sit beside the page, so nothing addresses the workspace", () => {
        const { messages, pictures } = shareTranscript(conversation, "everything");
        expect(messages[1]?.tools?.[0]?.content?.[1]).toEqual({ type: "image", path: "files/2-after.png" });
        expect(pictures.map((picture) => picture.published)).toEqual(["files/1-screenshot.png", "files/2-after.png"]);
        expect(JSON.stringify(messages)).not.toContain(".intentic/");
    });

    it("carries and redacts the task checklist in everything mode", () => {
        const withTodos: TranscriptRow[] = [
            {
                role: "assistant",
                text: "Working",
                todos: [
                    { content: "check sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", status: "completed" },
                    { content: "deploy", status: "in_progress", activeForm: "Deploying sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345" },
                ],
            },
        ];
        const { messages: msgsOnly } = shareTranscript(withTodos, "messages");
        expect(msgsOnly[0]?.todos).toBeUndefined();
        const { messages: everything } = shareTranscript(withTodos, "everything");
        expect(everything[0]?.todos).toEqual([
            { content: `check ${MASK}`, status: "completed" },
            { content: "deploy", status: "in_progress", activeForm: `Deploying ${MASK}` },
        ]);
    });
});

describe("both levels", () => {
    // The outbox refuses a file containing a credential (public-files.ts rule 5); a share rewrites to that same rule
    // instead of being blocked by it.
    it.each(["messages", "everything"] as const)("strips a self-identifying secret from a %s share", (detail) => {
        const published = JSON.stringify(shareTranscript(conversation, detail).messages);
        expect(published).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
        expect(published).toContain(MASK);
    });

    it("strips one out of the agent's work too, where a key is most likely to have been read out of a file", () => {
        const published = JSON.stringify(shareTranscript(conversation, "everything").messages);
        expect(published).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    // `checkpointId` addresses this machine's rewind state; `notes` has no surface on the published page. Neither means
    // anything to a recipient.
    it.each(["messages", "everything"] as const)("drops the daemon's own bookkeeping from a %s share", (detail) => {
        const [first] = shareTranscript(conversation, detail).messages;
        expect(first?.checkpointId).toBeUndefined();
        expect(first?.notes).toBeUndefined();
    });

    // An image entry only ever copies an actual image; nothing else it names leaves the workspace.
    it("publishes nothing that is not an image, however a tool labelled it", () => {
        const { messages, pictures } = shareTranscript(
            [
                {
                    role: "assistant",
                    text: "",
                    tools: [{ id: "t", name: "Read", category: "read", status: "completed", content: [{ type: "image", path: ".env" }] }],
                },
            ],
            "everything",
        );
        expect(pictures).toEqual([]);
        expect(messages[0]?.tools?.[0]?.content).toEqual([]);
    });

    // A silently wrong picture is worse than a missing one.
    it("keeps two pictures of the same name apart", () => {
        const { pictures } = shareTranscript(
            [
                {
                    role: "assistant",
                    text: "",
                    tools: [
                        {
                            id: "t",
                            name: "Read",
                            category: "read",
                            status: "completed",
                            content: [
                                { type: "image", path: "a/shot.png" },
                                { type: "image", path: "b/shot.png" },
                                { type: "image", path: "a/shot.png" },
                            ],
                        },
                    ],
                },
            ],
            "everything",
        );
        expect(pictures.map((picture) => picture.published)).toEqual(["files/1-shot.png", "files/2-shot.png"]);
    });
});

// Redaction replaces what the pattern matches, so a pattern that stopped at the header published the key's body.
describe("a private key in what the agent read", () => {
    it("keeps only its header and footer, whether its lines are real newlines or JSON escapes", () => {
        const pem =
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo\n4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onL\n-----END RSA PRIVATE KEY-----";
        const serviceAccount =
            '{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEF\\n-----END PRIVATE KEY-----\\n", "client_email": "bot@example.iam"}';
        const { messages } = shareTranscript(
            [
                {
                    role: "assistant",
                    text: "Read both.",
                    tools: [
                        { id: "t1", name: "Read", category: "read", status: "completed", content: [{ type: "text", text: `${pem}\nend of file` }] },
                        { id: "t2", name: "Read", category: "read", status: "completed", content: [{ type: "text", text: serviceAccount }] },
                    ],
                },
            ],
            "everything",
        );
        expect(messages[0]?.tools?.map((tool) => tool.content)).toEqual([
            [{ type: "text", text: `-----BEGIN RSA PRIVATE KEY-----\n${MASK}\n-----END RSA PRIVATE KEY-----\nend of file` }],
            [{ type: "text", text: `{"private_key": "-----BEGIN PRIVATE KEY-----\n${MASK}\n-----END PRIVATE KEY-----\\n", "client_email": "bot@example.iam"}` }],
        ]);
    });

    it("redacts an encrypted key's headers and a key the output cut short", () => {
        const encrypted =
            "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0A1B2C3D\n\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
        const cut = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU";
        const { messages } = shareTranscript([{ role: "user", text: `${encrypted}\nand\n${cut}` }], "messages");
        expect(messages[0]?.text).toBe(
            `-----BEGIN RSA PRIVATE KEY-----\n${MASK}\n-----END RSA PRIVATE KEY-----\nand\n-----BEGIN OPENSSH PRIVATE KEY-----\n${MASK}`,
        );
    });
});

// The invariant public-files.ts rule 5 states: a page this module masked is never then refused by the outbox's sniff, which
// would leave the share published but unserved. One sample of every shape the sniff knows, built rather than written out
// so no literal credential sits in the source.
describe("a shared page the outbox then sniffs", () => {
    const pem = (label: string, body: string, end = true): string =>
        `-----BEGIN ${label}-----\n${body}${end ? `\n-----END ${label}-----` : ""}`;
    const samples: Record<string, string> = {
        npm: `npm_${"a1B2".repeat(9)}`,
        "github classic": `ghp_${"a1B2".repeat(6)}`,
        "github oauth": `gho_${"a1B2".repeat(6)}`,
        "github fine-grained": `github_pat_${"a1B2_".repeat(11)}`,
        gitlab: `glpat-${"a1B2".repeat(5)}`,
        slack: `xoxb-2410-1230-${"AbCd".repeat(4)}`,
        openai: `sk-proj-${"a1B2".repeat(6)}`,
        anthropic: `sk-ant-api03-${"a1B2".repeat(6)}`,
        "stripe secret": `sk_live_${"a1B2".repeat(6)}`,
        "stripe restricted": `rk_live_${"a1B2".repeat(6)}`,
        "aws access key": `AKIA${"ABCD2345".repeat(2)}`,
        "aws session key": `ASIA${"ABCD2345".repeat(2)}`,
        google: `AIza${"a1B2_c3D4-".repeat(3)}abcde`,
        huggingface: `hf_${"a1B2".repeat(9)}`,
        digitalocean: `dop_v1_${"a1b2c3d4".repeat(8)}`,
        jwt: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"a1B2".repeat(8)}`,
        "url password": `postgres://app:${"s3cr3t-".repeat(2)}@db.internal:5432/app`,
        "rsa key": pem("RSA PRIVATE KEY", `${"MIIEowIBAAKCAQEA".repeat(4)}\n${"u1SU1LfVLPHCozMx".repeat(4)}`),
        "pkcs8 key": pem("PRIVATE KEY", "MIIEvQIBADANBgkqhkiG9w0BAQEF"),
        "encrypted key": pem("RSA PRIVATE KEY", "Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0A1B2C3D\n\nMIIEpAIBAAKCAQEA"),
        "key cut short": pem("OPENSSH PRIVATE KEY", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU", false),
        "key in json": JSON.stringify({ private_key: `${pem("PRIVATE KEY", "MIIEvQIBADANBgkqhkiG9w0BAQEF")}\n` }),
        "pgp key": pem("PGP PRIVATE KEY BLOCK", "Version: GnuPG v2\n\nlQOYBF0x8bEBCAC5\n=Xy1Z"),
        putty: `PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: me\nPublic-Lines: 1\nAAAAC3NzaC1lZDI1NTE5\nPrivate-Lines: 1\nAAAAIGr3dHg0\nPrivate-MAC: ${"ab12".repeat(16)}`,
    };

    const TEMPLATE = `<!doctype html><html><head><title>Shared conversation</title>
<script id="intentic-conversation" type="application/json">null</script></head><body></body></html>`;

    const published = (secret: string, detail: "messages" | "everything"): string => {
        const { messages } = shareTranscript(
            [
                { role: "user", text: `here it is: ${secret}\nthanks` },
                {
                    role: "assistant",
                    text: `Read ${secret}`,
                    thinking: secret,
                    tools: [{ id: "t", name: "Read", category: "read", status: "completed", content: [{ type: "text", text: secret }] }],
                },
            ],
            detail,
        );
        return sharePage(TEMPLATE, { title: redactSecrets(`about ${secret}`), sharedAt: 1786372320000, detail, messages });
    };

    it.each(Object.entries(samples))("serves a page that quoted a %s", (_shape, secret) => {
        expect(holdsCredentialToken(secret)).toBe(true);
        for (const detail of ["messages", "everything"] as const) {
            expect(holdsCredentialToken(published(secret, detail))).toBe(false);
        }
    });
});
