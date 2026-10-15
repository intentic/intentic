import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";
import { z } from "zod";
import { approvalsDir } from "../core/guard.js";
import { recordsDir } from "../core/records.js";
import { type Call, json, recorder } from "../core/http.testing.js";
import { main } from "./main.js";

// The CLI as the agent runs it: suffixed card env vars in, JSON on stdout out, exit 0 for an answer and 2 for a refusal.
// The network is a recorder; nothing leaves the process.

const EZD_ENV = {
    EZDRP_API_URL_URZAD: "https://integrator-api.example.test",
    EZDRP_SSO_URL_URZAD: "https://sso-idp.example.test",
    EZDRP_WEB_HOST_URZAD: "ezdrp-web.example.test",
    EZDRP_PID_URZAD: "pid",
    EZDRP_AKI_URZAD: "aki",
    EZDRP_API_KEY_URZAD: "synthetic",
    EZDRP_SID_URZAD: "sid",
    EZDRP_UID_URZAD: "",
};

const HeldSchema = z.object({ held: z.literal(true), approvalId: z.string() });

let root: string;
let calls: Call[];
const realFetch = globalThis.fetch;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "e-urzad-cli-"));
    await mkdir(join(root, STATE_GROUP_DIR.config), { recursive: true });
    const office = recorder((call) => (call.url.pathname === "/connect/token" ? json({ access_token: "t", expires_in: 3600 }) : json({ lista: [{ idDokument: "d", idDokumentPrzestrzeni: "dp", idDokumentWersja: "dw", idPrzestrzenRobocza: "pr" }] }, 201)));
    calls = office.calls;
    globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => office.fetcher(String(input), init), { preconnect: realFetch.preconnect });
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    await rm(root, { recursive: true, force: true });
});

const run = async (argv: readonly string[], env: Readonly<Record<string, string>> = EZD_ENV): Promise<{ readonly code: number; readonly out: string }> => {
    let out = "";
    const code = await main(argv, { ...env, INTENTIC_WORKSPACE: root }, (text) => {
        out += text;
    });
    return { code, out };
};

describe("e-urzad", () => {
    test("lists the office cards this shell carries", async () => {
        const { code, out } = await run(["cards"]);
        expect(code).toBe(0);
        expect(JSON.parse(out)).toEqual([{ service: "ezd-rp", card: "urzad" }]);
    });

    test("a missing card is a refusal in words, on stdout", async () => {
        const { code, out } = await run(["ed", "inbox"]);
        expect(code).toBe(2);
        expect(out).toStartWith("error: no e-Doręczenia card is connected");
    });

    test("an office write is held, and runs only through the approved command", async () => {
        const draft = join(root, "projekt.pdf");
        await writeFile(draft, "%PDF-1.7 projekt");
        const held = await run(["ezd", "attach", "sprawa-1", draft]);
        expect(held.code).toBe(0);
        const { approvalId } = HeldSchema.parse(JSON.parse(held.out));
        expect(calls).toHaveLength(0);

        expect((await run(["approved", approvalId])).out).toContain("not running");
        const itemPath = join(approvalsDir(root), `${approvalId}.json`);
        await writeFile(itemPath, JSON.stringify({ ...z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(itemPath, "utf8"))), status: "running" }));

        const moved = await run(["approved", approvalId], { ...EZD_ENV, EZDRP_API_URL_URZAD: "https://integrator-api.other.test" });
        expect(moved.out).toContain("not EZD RP integrator-api.example.test (podmiot pid) as approved; nothing was done");
        expect(calls).toHaveLength(0);

        const done = await run(["approved", approvalId]);
        expect(done.code).toBe(0);
        expect(JSON.parse(done.out)).toMatchObject({ approvalId, key: "ezdrp.case.attach-draft", result: { caseId: "sprawa-1" } });
        expect(calls.map((call) => call.url.pathname)).toEqual(["/connect/token", "/ezdrp/integrator/v2/sprawy/sprawa-1/dokumenty"]);
        const snapshot = z.object({ actions: z.array(z.object({ key: z.string(), approvalId: z.string() })) }).parse(JSON.parse(await readFile(join(recordsDir(root, "urzad"), "snapshot.json"), "utf8")));
        expect(snapshot.actions[0]).toMatchObject({ key: "ezdrp.case.attach-draft", approvalId });
    });

    test("an allow rule acts at once, a deny rule refuses", async () => {
        const draft = join(root, "projekt.pdf");
        await writeFile(draft, "%PDF-1.7 projekt");
        await writeFile(join(root, STATE_GROUP_DIR.config, "settings.json"), JSON.stringify({ actionRules: { "ezdrp.*": "deny" } }));
        expect((await run(["ezd", "attach", "sprawa-1", draft])).out).toContain("refused by this sandbox's action rules");
        await writeFile(join(root, STATE_GROUP_DIR.config, "settings.json"), JSON.stringify({ actionRules: { "ezdrp.case.attach-draft": "allow" } }));
        expect(JSON.parse((await run(["ezd", "attach", "sprawa-1", draft])).out)).toMatchObject({ caseId: "sprawa-1" });
    });

    test("an unknown flag is refused rather than ignored", async () => {
        const { code, out } = await run(["ezd", "cases", "--stauts", "all"]);
        expect(code).toBe(2);
        expect(out).toContain("stauts");
    });
});
