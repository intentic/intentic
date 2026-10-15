import { z } from "zod";
import { JsonValueSchema } from "../core/json.js";
import type { CaseRow, TaskRow } from "../core/snapshot.js";

// The parts of EZD RP Integrator API v2 answers this client reads, from the public OpenAPI 3 document
// (https://integrator-api.demo.ezdrp.gov.pl/swagger/v2/swagger.json, changelog to v2.11.5). Objects are loose: every
// field the office sends survives into what the agent sees; only the fields named here are relied on.

const text = z.string().nullish().transform((value) => value ?? undefined);

// IntegratorTablePageResultDto. Real answers omit pagesCount, so isNextPageExists (or a short page) ends the walk.
const PageResultSchema = z.looseObject({
    pageNumber: z.number(),
    pageSize: z.number(),
    pagesCount: z.number().nullish(),
    isNextPageExists: z.boolean().nullish(),
});

export const pageOf = <T extends z.ZodType>(item: T) => z.looseObject({ lista: z.array(item), pageInfo: PageResultSchema });

// V2PostSprawyWyszukajDto (POST /sprawy/_search).
export const CaseListItemSchema = z.looseObject({
    idSprawa: z.string(),
    tytul: z.string(),
    znak: text,
    status: z.string(),
    terminZalatwienia: text,
    dataWszczecia: text,
});

// V2GetObiegiDto (GET /obiegi): one task on the position's "Do obsłużenia" list.
export const TaskItemSchema = z.looseObject({
    idZadanie: z.string(),
    idObieg: z.string(),
    dataOtrzymania: z.string(),
    statusOpis: z.string(),
    tytulDokumentu: z.string(),
    numerSprawy: text,
    tytulSprawy: text,
    numerRpw: text,
});

// V2UzytkownikDto (GET /struktura/uzytkownik).
export const UserSchema = z.looseObject({
    imie: text,
    nazwisko: text,
    idStanowisko: text,
    stanowiskoNazwa: text,
    podmiotNazwa: text,
    listaStanowisk: z.array(z.looseObject({ idStanowisko: z.string(), stanowiskoNazwa: text, komorkaOrganizacyjnaNazwa: text })).nullish(),
});
export type EzdUser = z.infer<typeof UserSchema>;

export const LinkSchema = z.looseObject({ link: z.string() });

// V2DokumentDto, what an upload answers per file.
export const CreatedDocumentsSchema = z.looseObject({
    lista: z.array(z.looseObject({ idDokument: z.string(), idDokumentPrzestrzeni: z.string(), idDokumentWersja: z.string(), idPrzestrzenRobocza: z.string() })),
});

export const CreatedFlowSchema = z.looseObject({ listaIdObieg: z.array(z.string()) });

export const AnyJsonSchema = JsonValueSchema;
export const AnyObjectSchema = z.record(z.string(), JsonValueSchema);

// The JRWA symbol inside a case sign: <unit symbol(s)>.<JRWA>.<number>.<year>, e.g. "SSPASI.000.3.2025" gives "000".
// Read off the examples in the EZD RP manual, not a documented field; undefined when the sign has another shape.
export const jrwaOf = (sign: string | undefined): string | undefined => {
    const parts = sign?.split(".") ?? [];
    return parts.length >= 4 && /^\d{4}$/.test(parts.at(-1) ?? "") && /^\d+$/.test(parts.at(-2) ?? "") ? parts.at(-3) : undefined;
};

export const caseRow = (item: z.infer<typeof CaseListItemSchema>): CaseRow => ({
    id: item.idSprawa,
    sign: item.znak,
    title: item.tytul,
    status: item.status,
    jrwa: jrwaOf(item.znak),
    deadline: item.terminZalatwienia,
    started: item.dataWszczecia,
});

export const taskRow = (item: z.infer<typeof TaskItemSchema>): TaskRow => ({
    id: item.idZadanie,
    flowId: item.idObieg,
    received: item.dataOtrzymania,
    status: item.statusOpis,
    documentTitle: item.tytulDokumentu,
    caseSign: item.numerSprawy,
    caseTitle: item.tytulSprawy,
    registryNumber: item.numerRpw,
});

// StatusSprawy (the spec's enum, described in the manual).
export const CASE_STATUS = {
    all: 0,
    open: 1,
    postponed: 2,
    suspended: 3,
    closed: 4,
    resumed: 5,
} as const;
export const CaseStatusNameSchema = z.enum(["all", "open", "postponed", "suspended", "closed", "resumed"]);
export type CaseStatusName = z.infer<typeof CaseStatusNameSchema> & keyof typeof CASE_STATUS;
