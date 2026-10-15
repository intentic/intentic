import { z } from "zod";
import type { Http } from "./http.js";

/* THE SEJM'S ELI API (https://api.sejm.gov.pl/eli, OpenAPI at /eli/openapi/): every act published in Dziennik Ustaw
   (DU) and Monitor Polski (MP), its metadata, the acts that refer to it, and its text as HTML and PDF. Shapes as
   observed live in October 2026:
   - an act's `inForce` (IN_FORCE / NOT_IN_FORCE / UNKNOWN) is about that act; an amending act stays IN_FORCE forever.
   - a consolidated text ("tekst jednolity") is a separate act, an "Obwieszczenie" listed under the original's
     `references["Inf. o tekście jednolitym"]`; its `legalStatusDate` is the date its wording is current to, and
     the newest one is usually PDF-only for months (`textHTML: false`, and text.html answers 200 with an empty body).
   - `references["Akty zmieniające"]` lists amending acts with the date each change takes effect for this act, future
     ones included.
   - `texts` names the files: H html, O the published PDF, T the Chancellery's copy of it, U a unified text ("tekst
     ujednolicony") the Chancellery keeps current between consolidations, which has no legal force.
   - search returns full records, sorted by publisher and position rather than relevance; `inForce=1` filters, there
     is no filter for repealed acts. */

const ReferenceSchema = z.object({ id: z.string(), date: z.string().optional(), art: z.string().optional() });
export type Reference = z.infer<typeof ReferenceSchema>;

export const ActSchema = z.object({
    ELI: z.string(),
    address: z.string().optional(),
    publisher: z.string(),
    year: z.number(),
    volume: z.number().optional(),
    pos: z.number(),
    title: z.string(),
    type: z.string(),
    displayAddress: z.string(),
    status: z.string().optional(),
    inForce: z.string().optional(),
    promulgation: z.string().optional(),
    announcementDate: z.string().optional(),
    entryIntoForce: z.string().optional(),
    validFrom: z.string().optional(),
    repealDate: z.string().optional(),
    expirationDate: z.string().optional(),
    legalStatusDate: z.string().optional(),
    changeDate: z.string().optional(),
    textHTML: z.boolean().optional(),
    textPDF: z.boolean().optional(),
    texts: z.array(z.object({ fileName: z.string(), type: z.string() })).optional(),
    references: z.record(z.string(), z.array(ReferenceSchema)).optional(),
});
export type Act = z.infer<typeof ActSchema>;

export const SearchPageSchema = z.object({ totalCount: z.number(), offset: z.number().optional(), items: z.array(ActSchema) });
export type SearchPage = z.infer<typeof SearchPageSchema>;

export interface SearchQuery {
    readonly title?: string | undefined;
    readonly keyword?: string | undefined;
    readonly publisher?: string | undefined;
    readonly year?: string | undefined;
    readonly type?: string | undefined;
    readonly inForce?: boolean | undefined;
    readonly limit: number;
    readonly offset?: number | undefined;
}

export const ELI_API = "https://api.sejm.gov.pl/eli";

// An act's identifier as the API and the citation both use it: "DU/1960/168". Accepts the ELI URI and ISAP's address
// ("WDU19600300168") too, since agents paste whichever they found.
export const actId = (raw: string): string => {
    const trimmed = raw.trim();
    const eli = /(?:^|\/eli\/(?:acts\/)?)(DU|MP)\/(\d{4})\/(\d+)/iu.exec(trimmed);
    if (eli !== null) {
        return `${(eli[1] ?? "").toUpperCase()}/${eli[2] ?? ""}/${String(Number(eli[3]))}`;
    }
    const isap = /^W(DU|MP)(\d{4})\d{3}(\d{4})$/iu.exec(trimmed);
    if (isap !== null) {
        return `${(isap[1] ?? "").toUpperCase()}/${isap[2] ?? ""}/${String(Number(isap[3]))}`;
    }
    throw new Error(`"${raw}" is not an act address: use DU/<year>/<position> or MP/<year>/<position>, e.g. DU/1960/168`);
};

export class Eli {
    constructor(private readonly http: Http) {}

    async search(query: SearchQuery): Promise<SearchPage> {
        const url = new URL(`${ELI_API}/acts/search`);
        const params = {
            title: query.title,
            keyword: query.keyword,
            publisher: query.publisher,
            year: query.year,
            type: query.type,
            inForce: query.inForce === true ? "1" : undefined,
            limit: String(query.limit),
            offset: query.offset === undefined ? undefined : String(query.offset),
        } satisfies Record<string, string | undefined>;
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== "") {
                url.searchParams.set(key, value);
            }
        }
        return await this.http.json(url.toString(), SearchPageSchema);
    }

    async act(id: string): Promise<Act> {
        return await this.http.json(`${ELI_API}/acts/${id}`, ActSchema);
    }

    // An act's HTML, or undefined when it has none: the API answers 200 with an empty body for an act without one.
    async html(id: string): Promise<string | undefined> {
        const html = await this.http.text(`${ELI_API}/acts/${id}/text.html`);
        return html.trim() === "" ? undefined : html;
    }

    // The published PDF, or one of the act's named files (`texts`): the unified text is `U`.
    async pdf(id: string, file?: { readonly type: string; readonly fileName: string }): Promise<Uint8Array> {
        const path = file === undefined ? "text.pdf" : `text/${file.type}/${encodeURIComponent(file.fileName)}`;
        return await this.http.bytes(`${ELI_API}/acts/${id}/${path}`);
    }
}
