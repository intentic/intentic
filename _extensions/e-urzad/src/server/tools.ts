import { resolve } from "node:path";
import { realInside } from "@intentic/base/contained";
import type { ToolCard, ToolDefinition, ToolResult } from "@intentic/extension-api";
import { z } from "zod";
import { ezdFromConfig } from "../core/cards.js";
import { trustCachePath } from "../core/paths.js";
import { EzdClient } from "../ezd/integrator.js";
import { CaseStatusNameSchema } from "../ezd/integrator-schemas.js";
import { causeText } from "../signatures/engine.js";
import { trustListEvaluator } from "../signatures/trust/evaluate.js";
import { readTrustCache } from "../signatures/trust/lists.js";
import { verifyFile } from "../signatures/verify.js";

// The agent's tools for one connected EZD RP card, served by the host (`contributes.tools.perCard: "ezd-rp"`): the
// daemon mounts them into every turn granted the card, on every runtime, as a server named by the card's id, and hands
// the card's settings with each call. Reads and signature checks only. The office writes stay on the `e-urzad` CLI,
// where they go through the action-rule guard and the approvals queue. e-Doręczenia is on the CLI as well: the manifest
// format serves tools for one card kind per extension.

const answer = <T>(value: T): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value ?? null, undefined, 2) }] });
const failure = (cause: unknown): ToolResult => ({ content: [{ type: "text", text: causeText(cause) }], isError: true });

type Fields = Readonly<Record<string, z.ZodType>>;

// One tool from its argument fields: the host lists their JSON Schema, and each call's arguments are parsed by the same
// schema before `run` sees them, so a malformed call answers with zod's own refusal.
const tool = <F extends Fields, Answer>(name: string, description: string, fields: F, run: (args: z.infer<z.ZodObject<F>>) => Promise<Answer>): ToolDefinition => {
    const schema = z.object(fields);
    return {
        name,
        description,
        effect: "read",
        inputSchema: z.toJSONSchema(schema, { io: "input" }),
        call: async (args) => {
            const parsed = schema.safeParse(args);
            if (!parsed.success) {
                return failure(new Error(z.prettifyError(parsed.error)));
            }
            try {
                return answer(await run(parsed.data));
            } catch (cause) {
                return failure(cause);
            }
        },
    };
};

// A workspace path, refused when it resolves (symlinks included) outside the workspace.
const insideWorkspace = async (root: string, path: string): Promise<string> => {
    const actual = await realInside(root, resolve(root, path));
    if (actual === undefined) {
        throw new Error(`${path} is outside the workspace`);
    }
    return actual;
};

const verifyTool = (root: string): ToolDefinition =>
    tool(
        "verify_signature",
        "Check an electronic signature in a workspace file: XAdES (.xml, .xades), PAdES (signed PDF) or CAdES (.p7s, .p7m, .sig; give `content` for a detached one). Reports per signature: integrity, what it covers, the signer certificate (subject with serialNumber/PESEL, issuer, validity, serial), its QcStatements claims (QcCompliance, QSCD, QcType), signing time, time-stamps, and the trust chain against the cached EU trusted list, or 'trust chain not checked' when none is cached. Never reports a signature as qualified-valid: revocation is not checked.",
        { path: z.string().describe("The signature file, workspace-relative"), content: z.string().optional().describe("The signed file of a detached signature, workspace-relative") },
        async ({ path, content }) =>
            verifyFile(await insideWorkspace(root, path), content === undefined ? undefined : await insideWorkspace(root, content), trustListEvaluator(await readTrustCache(trustCachePath(root)))),
    );

const clients = new Map<string, EzdClient>();

// One client per card settings, so a token is reused across calls until it expires.
const clientFor = (card: ToolCard): EzdClient => {
    const settings = ezdFromConfig(card.id, card.config);
    const key = JSON.stringify(settings);
    const known = clients.get(key);
    if (known !== undefined) {
        return known;
    }
    const client = new EzdClient(settings);
    clients.set(key, client);
    return client;
};

const limit = z.number().int().min(1).max(500).optional();

export const ezdTools = (card: ToolCard, root: string): ToolDefinition[] => [
    tool("ezd_test", "Exchange this card's EZD RP API key for a token and read the user and one task: the connection test.", {}, () => clientFor(card).test()),
    tool(
        "ezd_cases",
        "Search EZD RP cases (sprawy). Rows carry id (idSprawa), sign (znak sprawy), title, status, the JRWA symbol read off the sign, deadline. Status defaults to cases in progress.",
        { status: CaseStatusNameSchema.optional(), sign: z.string().optional(), jrwa: z.string().optional(), title: z.string().optional(), limit },
        ({ status, sign, jrwa, title, limit: max }) => clientFor(card).cases({ status, sign, jrwa, title }, max ?? 100),
    ),
    tool(
        "ezd_case",
        "One EZD RP case as the API returns it, optionally with its metadata (metadane) and its documents.",
        { id: z.string().describe("idSprawa"), metadata: z.boolean().optional(), documents: z.boolean().optional() },
        async ({ id, metadata, documents }) => {
            const client = clientFor(card);
            return { case: await client.case(id), metadata: metadata === true ? await client.caseMetadata(id) : null, documents: documents === true ? await client.caseDocuments(id) : null };
        },
    ),
    tool("ezd_tasks", "The tasks on this card's EZD RP position (the 'Do obsłużenia' list): received date, status, document title, case sign, RPW number.", { limit }, ({ limit: max }) => clientFor(card).tasks(max ?? 100)),
    tool(
        "ezd_document",
        "One EZD RP document (by idDokumentPrzestrzeni), optionally with metadata and its EZD signature records. To read the file itself, run `e-urzad ezd download <id>` and open what it saves.",
        { id: z.string().describe("idDokumentPrzestrzeni"), metadata: z.boolean().optional(), signatures: z.boolean().optional() },
        async ({ id, metadata, signatures }) => {
            const client = clientFor(card);
            return { document: await client.document(id), metadata: metadata === true ? await client.documentMetadata(id) : null, signatures: signatures === true ? await client.documentSignatures(id) : null };
        },
    ),
    verifyTool(root),
];
