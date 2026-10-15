import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCard } from "@intentic/extension-api";
import { type FakeExtension, fakeExtensionApi } from "@intentic/extension-api/testing";
import { z } from "zod";
import manifest from "../../intentic-extension.json";
import { OfficeRecords } from "../core/records.js";
import { pki, signCms } from "../signatures/fixtures.testing.js";
import { activateServer } from "./server.js";

// The backend on the real extension runtime, with only the daemon stood in for: every daemon call it makes is judged
// against the manifest's declared reach, as the daemon's grant would.

const CARD: ToolCard = {
    id: "urzad",
    config: { provider: "ezd-rp", apiUrl: "https://integrator-api.example.test", ssoUrl: "https://sso-idp.example.test", webHost: "ezdrp-web.example.test", subjectId: "pid", keyId: "aki", apiKey: "synthetic", positionId: "sid" },
};
const CONNECTIONS: ReadonlyMap<string, { readonly kind: string; readonly config: Readonly<Record<string, string>> }> = new Map([
    ["urzad", { kind: "cli", config: CARD.config }],
    ["github", { kind: "cli", config: { provider: "github", token: "x" } }],
]);

const ResultSchema = z.object({ content: z.array(z.object({ text: z.string() })), isError: z.boolean().optional() });
const ReportSchema = z.object({ signatures: z.array(z.object({ integrity: z.string(), trust: z.object({ detail: z.string() }) })) });

let root: string;
let fake: FakeExtension;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "e-urzad-server-"));
    await mkdir(join(root, "pisma"), { recursive: true });
    const parties = await pki();
    await writeFile(join(root, "pisma", "wniosek.p7m"), await signCms(new Uint8Array(Buffer.from("treść wniosku")), parties.signer));
    fake = await fakeExtensionApi({
        manifest: { publisher: manifest.publisher, name: manifest.name, permissions: manifest.permissions },
        workspaceRoot: root,
        daemon: (request) => {
            const id = decodeURIComponent(new URL(request.url).pathname.split("/")[2] ?? "");
            const found = CONNECTIONS.get(id);
            return found === undefined ? undefined : Response.json({ id, ...found });
        },
    });
    await fake.activate({ activateServer });
});

afterAll(async () => {
    await fake.dispose();
    await rm(root, { recursive: true, force: true });
});

const call = async (name: string, args: Readonly<Record<string, string>>) => ResultSchema.parse(await fake.callTool(name, args, CARD));

describe("the EZD RP card's agent tools", () => {
    test("an extension-level server serves nothing; a card gets reads and the signature check, never a write", async () => {
        expect(await fake.tools()).toEqual([]);
        const tools = await fake.tools(CARD);
        expect(tools.map((tool) => tool.name)).toEqual(["ezd_test", "ezd_cases", "ezd_case", "ezd_tasks", "ezd_document", "verify_signature"]);
        expect(tools.every((tool) => tool.effect === "read")).toBe(true);
    });

    test("verify_signature checks a workspace file and says the trust chain was not checked", async () => {
        const result = await call("verify_signature", { path: "pisma/wniosek.p7m" });
        const report = ReportSchema.parse(JSON.parse(result.content[0]?.text ?? "{}"));
        expect(report.signatures[0]?.integrity).toBe("valid");
        expect(report.signatures[0]?.trust.detail).toContain("trust chain not checked");
    });

    test("verify_signature refuses a path outside the workspace", async () => {
        expect((await call("verify_signature", { path: "../../etc/passwd" })).isError).toBe(true);
    });
});

describe("the view's backend", () => {
    test("overview answers what the records hold", async () => {
        await new OfficeRecords(root, "urzad", "ezd-rp").update((current) => ({ ...current, syncedAt: "2026-10-13T10:00:00.000Z", cases: [{ id: "s1", title: "Wniosek o dostęp do informacji publicznej", status: "W toku" }] }));
        const response = await fake.route("accounts/urzad/overview?service=ezd-rp");
        const body = z.object({ snapshot: z.object({ cases: z.array(z.object({ id: z.string() })) }) }).parse(await response.json());
        expect(body.snapshot.cases.map((row) => row.id)).toEqual(["s1"]);
    });

    test("a card that is not an office card is refused through the declared daemon route", async () => {
        expect((await fake.route("accounts/github/test", { method: "POST" })).status).toBe(404);
        expect(fake.calls.map((entry) => entry.admitted)).toEqual([true]);
    });
});
