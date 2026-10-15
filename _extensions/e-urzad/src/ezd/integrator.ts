import { z } from "zod";
import { type AccessToken, endpoint, type Fetch, httpsUrl, jsonInit, parseJson, request } from "../core/http.js";
import { type JsonObject, type JsonValue, toJson } from "../core/json.js";
import type { CaseRow, TaskRow } from "../core/snapshot.js";
import { bareHost, exchangeKey, type EzdSettings } from "./key-exchange.js";
import { AnyJsonSchema, AnyObjectSchema, CASE_STATUS, type CaseStatusName, CaseListItemSchema, caseRow, CreatedDocumentsSchema, CreatedFlowSchema, type EzdUser, LinkSchema, pageOf, TaskItemSchema, taskRow, UserSchema } from "./integrator-schemas.js";

// EZD RP Integrator API v2 for one connected card. Paths are those of the public OpenAPI document; every call carries
// the bearer token and the Sid header (the EZD position the call acts in), as the manual's "Walidacje stanowisk"
// article requires. Reads are free; the writes at the bottom are only ever called by the guard (core/guard.ts) once the
// action rules allow them or the owner approved them.

const PREFIX = ["ezdrp", "integrator", "v2"];
const PAGE_SIZE = 25;
const PAGE_LIMIT = 400;

export interface CaseFilter {
    readonly status?: CaseStatusName;
    readonly sign?: string;
    readonly jrwa?: string;
    readonly title?: string;
    readonly handler?: string;
    readonly startedFrom?: string;
    readonly startedTo?: string;
}

export interface UploadFile {
    readonly name: string;
    readonly bytes: Uint8Array;
}

export interface DownloadedDocument {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
}

export class EzdClient {
    private token: AccessToken | undefined;
    private position: string | undefined;

    constructor(
        readonly settings: EzdSettings,
        private readonly fetcher: Fetch = fetch,
        private readonly clock: () => Date = () => new Date(),
    ) {
        httpsUrl(settings.apiUrl, "integrator API address");
        httpsUrl(settings.ssoUrl, "SSO address");
        this.position = settings.positionId?.trim() === "" ? undefined : settings.positionId?.trim();
    }

    private url(segments: readonly string[], query?: Readonly<Record<string, string | undefined>>): string {
        return endpoint(this.settings.apiUrl, [...PREFIX, ...segments], query);
    }

    private async bearer(): Promise<string> {
        const now = this.clock();
        if (this.token === undefined || this.token.expiresAt <= now.getTime()) {
            this.token = await exchangeKey(this.settings, this.fetcher, now);
        }
        return this.token.value;
    }

    // The position (Sid) every call names: the card's, else the user's current one as /struktura/uzytkownik reports it.
    // Whether that one call is accepted without a Sid is not documented; the card's field avoids relying on it.
    private async headers(): Promise<Record<string, string>> {
        const authorization = `Bearer ${await this.bearer()}`;
        if (this.position === undefined) {
            const response = await request(this.fetcher, this.url(["struktura", "uzytkownik"]), { headers: { authorization, accept: "application/json" } });
            const user = await parseJson(response, UserSchema, "EZD RP user");
            const positions = user.listaStanowisk ?? [];
            this.position = user.idStanowisko ?? (positions.length === 1 ? positions[0]?.idStanowisko : undefined);
            if (this.position === undefined) {
                throw new Error(`this EZD RP user has ${positions.length} positions; put the one to act in on the card (Sid): ${positions.map((entry) => `${entry.idStanowisko} ${entry.stanowiskoNazwa ?? ""}`).join(", ")}`);
            }
        }
        return { authorization, sid: this.position, accept: "application/json" };
    }

    private async get<T>(segments: readonly string[], schema: z.ZodType<T>, what: string, query?: Readonly<Record<string, string | undefined>>): Promise<T> {
        return parseJson(await request(this.fetcher, this.url(segments, query), { headers: await this.headers() }), schema, what);
    }

    private async post<T>(segments: readonly string[], body: JsonValue, schema: z.ZodType<T>, what: string): Promise<T> {
        return parseJson(await request(this.fetcher, this.url(segments), jsonInit("POST", body, await this.headers())), schema, what);
    }

    private async walk<T>(fetchPage: (page: number) => Promise<{ readonly lista: readonly T[]; readonly pageInfo: z.infer<ReturnType<typeof pageOf>>["pageInfo"] }>, limit: number): Promise<T[]> {
        const rows: T[] = [];
        for (let page = 0; rows.length < limit && page < PAGE_LIMIT; page += 1) {
            const answer = await fetchPage(page);
            rows.push(...answer.lista);
            const last = answer.pageInfo.isNextPageExists === false || answer.lista.length < PAGE_SIZE || (answer.pageInfo.pagesCount !== undefined && answer.pageInfo.pagesCount !== null && page + 1 >= answer.pageInfo.pagesCount);
            if (last) {
                break;
            }
        }
        return rows.slice(0, limit);
    }

    async me(): Promise<EzdUser> {
        return this.get(["struktura", "uzytkownik"], UserSchema, "EZD RP user");
    }

    // POST /sprawy/_search. The status alone is a valid criterion (the operation's description says so); it defaults
    // to cases in progress rather than the API's "all".
    async cases(filter: CaseFilter = {}, limit = 100): Promise<CaseRow[]> {
        const criteria = [
            ["znakSprawy", filter.sign],
            ["jrwa", filter.jrwa],
            ["tytulSprawy", filter.title],
            ["prowadzacySprawe", filter.handler],
            ["dataWszczeciaOd", filter.startedFrom],
            ["dataWszczeciaDo", filter.startedTo],
        ] as const;
        const given = criteria.flatMap(([key, value]) => (value === undefined || value === "" ? [] : [[key, value] as const]));
        const body = Object.fromEntries([["status", CASE_STATUS[filter.status ?? "open"]], ...given]);
        const rows = await this.walk((page) => this.post(["sprawy", "_search"], { ...body, pageInfo: { pageNumber: page, pageSize: PAGE_SIZE } }, pageOf(CaseListItemSchema), "EZD RP case search"), limit);
        return rows.map(caseRow);
    }

    async case(id: string): Promise<JsonObject> {
        return this.get(["sprawy", id], AnyObjectSchema, "EZD RP case");
    }

    async caseMetadata(id: string): Promise<JsonObject> {
        return this.get(["sprawy", id, "metadane"], AnyObjectSchema, "EZD RP case metadata");
    }

    async caseDocuments(id: string, limit = 200): Promise<JsonValue[]> {
        return this.walk((page) => this.get(["sprawy", id, "dokumenty"], pageOf(AnyJsonSchema), "EZD RP case documents", { page: String(page), pageSize: String(PAGE_SIZE) }), limit);
    }

    // POST /dokumenty/_search: the server wants at least two criteria (it answers 400 "Wypełnij minimum dwa kryteria").
    async searchDocuments(criteria: JsonObject, limit = 100): Promise<JsonValue[]> {
        const named = Object.entries(criteria).filter(([key, value]) => key !== "pageInfo" && value !== null && value !== "");
        if (named.length < 2) {
            throw new Error("EZD RP searches documents only with at least two criteria (e.g. tytul and dataUtworzeniaOd)");
        }
        return this.walk((page) => this.post(["dokumenty", "_search"], { ...criteria, pageInfo: { pageNumber: page, pageSize: PAGE_SIZE } }, pageOf(AnyJsonSchema), "EZD RP document search"), limit);
    }

    async document(id: string): Promise<JsonObject> {
        return this.get(["dokumenty", id], AnyObjectSchema, "EZD RP document");
    }

    async documentMetadata(id: string): Promise<JsonObject> {
        return this.get(["dokumenty", id, "metadane"], AnyObjectSchema, "EZD RP document metadata");
    }

    async documentSignatures(id: string): Promise<JsonValue> {
        return this.get(["dokumenty", id, "podpisy"], AnyJsonSchema, "EZD RP document signatures");
    }

    // GET /obiegi: the tasks on the position's "Do obsłużenia" list (status 1 = not taken up, 2 = taken up).
    async tasks(limit = 200, status?: 1 | 2): Promise<TaskRow[]> {
        const rows = await this.walk(
            (page) => this.get(["obiegi"], pageOf(TaskItemSchema), "EZD RP tasks", { page: String(page), pageSize: String(PAGE_SIZE), status: status === undefined ? undefined : String(status) }),
            limit,
        );
        return rows.map(taskRow);
    }

    // The hosts a download link may point at without leaving this instance: the API's, the web app's, and the file
    // repository beside them (filerepo-api.<the API's domain>), which is how installations are laid out.
    private instanceHosts(): Set<string> {
        const api = httpsUrl(this.settings.apiUrl).hostname;
        const domain = api.split(".").slice(1).join(".");
        return new Set([api, bareHost(this.settings.webHost), `filerepo-api.${domain}`]);
    }

    // GET /dokumenty/{id}/link answers a download address; the API documents no more than that. It is fetched without
    // credentials first, and with them only when it answers 401/403 and only on this instance's own hosts.
    async download(id: string, fallbackName: string): Promise<DownloadedDocument> {
        const { link } = await this.get(["dokumenty", id, "link"], LinkSchema, "EZD RP download link");
        const url = new URL(link, this.settings.apiUrl);
        if (url.protocol !== "https:" || !this.instanceHosts().has(url.hostname)) {
            throw new Error(`EZD RP gave a download address on ${url.host}, outside this instance; not fetched`);
        }
        let response = await request(this.fetcher, url.href, {}, { accept: [401, 403] });
        if (response.status === 401 || response.status === 403) {
            response = await request(this.fetcher, url.href, { headers: await this.headers() });
        }
        const disposition = response.headers.get("content-disposition") ?? "";
        const named = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)"?/i.exec(disposition)?.[1];
        return {
            name: named === undefined ? fallbackName : decodeURIComponent(named),
            bytes: new Uint8Array(await response.arrayBuffer()),
            contentType: response.headers.get("content-type") ?? "application/octet-stream",
        };
    }

    async test(): Promise<{ readonly user: string; readonly position: string; readonly tasks: number }> {
        const user = await this.me();
        const tasks = await this.tasks(1);
        return { user: [user.imie, user.nazwisko].filter((part) => part !== undefined).join(" ") || "(no name)", position: this.position ?? "", tasks: tasks.length };
    }

    /* ---- writes: called only through the guard ---------------------------------------------------------------- */

    private async upload<T>(segments: readonly string[], field: "file" | "files", files: readonly UploadFile[], schema: z.ZodType<T>, what: string): Promise<T> {
        const form = new FormData();
        for (const file of files) {
            form.append(field, new Blob([new Uint8Array(file.bytes)]), file.name);
        }
        const headers = await this.headers();
        return parseJson(await request(this.fetcher, this.url(segments), { method: "POST", headers, body: form }), schema, what);
    }

    // POST /sprawy/{id}/dokumenty (multipart `files`): the files become documents in the case's folder.
    async attachToCase(caseId: string, files: readonly UploadFile[]): Promise<JsonObject> {
        if (files.length === 0) {
            throw new Error("nothing to attach");
        }
        const created = await this.upload(["sprawy", caseId, "dokumenty"], "files", files, CreatedDocumentsSchema, "EZD RP attach to case");
        return { caseId, documents: toJson(created.lista) };
    }

    // A received file becomes a "Dokument" task on the position (POST /obiegi takes exactly one file); its document is
    // what the register entry is made for.
    private async documentForFile(file: UploadFile): Promise<{ readonly documentId: string; readonly flowId: string }> {
        const created = await this.upload(["obiegi"], "file", [file], CreatedFlowSchema, "EZD RP new document task");
        const flowId = created.listaIdObieg[0];
        if (flowId === undefined) {
            throw new Error("EZD RP created no task for the file");
        }
        const documents = await this.get(["obiegi", flowId, "dokumenty"], pageOf(AnyObjectSchema), "EZD RP task documents", { page: "0", pageSize: String(PAGE_SIZE) });
        const first = z.string().safeParse(documents.lista[0]?.["idDokumentPrzestrzeni"]);
        if (!first.success) {
            throw new Error(`EZD RP created task ${flowId} but listed no document in it`);
        }
        return { documentId: first.data, flowId };
    }

    // PUT /rpw/{numer}/{rok}/metadane, addressed by the "RPW/<numer>/<rok>" number the registration answered.
    private async fillRegisterMetadata(registryNumber: string, metadata: JsonObject): Promise<JsonValue> {
        const parts = /^RPW\/(\d+)\/(\d{4})$/.exec(registryNumber);
        if (parts?.[1] === undefined || parts[2] === undefined) {
            throw new Error(`registered, but the RPW number "${registryNumber}" is not RPW/<number>/<year>, so the metadata was not filled in`);
        }
        const response = await request(this.fetcher, this.url(["rpw", parts[1], parts[2], "metadane"]), jsonInit("PUT", metadata, await this.headers()), { accept: [204] });
        return response.status === 204 ? "filled in" : parseJson(response, AnyJsonSchema, "EZD RP RPW metadata");
    }

    // The incoming-mail registration the manual's RPW article walks through: the document (an existing one, or one made
    // from the file) is registered in the RPW register (POST /dokumenty/{id}/rpw), and the entry's metadata is filled
    // in when given.
    async registerIncoming(input: { readonly documentId?: string | undefined; readonly file?: UploadFile | undefined; readonly metadata?: JsonObject | undefined }): Promise<JsonObject> {
        if (input.documentId === undefined && input.file === undefined) {
            throw new Error("register-incoming needs an EZD document id or a file");
        }
        const made = input.file === undefined || input.documentId !== undefined ? undefined : await this.documentForFile(input.file);
        const documentId = input.documentId ?? made?.documentId ?? "";
        const registration = await this.post(["dokumenty", documentId, "rpw"], {}, AnyObjectSchema, "EZD RP RPW registration");
        const number = z.string().safeParse(registration["numerRpw"]);
        const metadata = input.metadata === undefined ? null : await this.fillRegisterMetadata(number.success ? number.data : "", input.metadata);
        return { documentId, flowId: made?.flowId ?? null, registration, metadata };
    }

    // POST /kw/wyslanie: a paper outgoing-mail record (V2PostWyslijKorespondencjeCommand), taken as the office prepared it.
    async registerOutgoing(payload: JsonObject): Promise<JsonObject> {
        return this.post(["kw", "wyslanie"], payload, AnyObjectSchema, "EZD RP outgoing mail");
    }
}
