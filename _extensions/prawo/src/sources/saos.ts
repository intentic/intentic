import { z } from "zod";
import type { Http } from "./http.js";

/* SAOS, the System Analizy Orzeczeń Sądowych (https://www.saos.org.pl/api): Polish court rulings with full text, free
   and keyless. What it holds, measured in October 2026: common courts are current (judgments from weeks ago); the
   Supreme Court stops in 2016, the Constitutional Tribunal in 2015, the National Appeal Chamber (KIO) in 2018; the
   administrative courts (WSA, NSA) are absent altogether. A few records carry typo'd dates in the far future
   ("3013-12-04"), which sort first by date, so a search is capped at today. Search hits carry a highlighted excerpt in
   `textContent` (`<em>` around matches); a judgment carries the whole text as HTML. */

const CourtCaseSchema = z.object({ caseNumber: z.string() });
const DivisionSchema = z.object({
    name: z.string().nullish(),
    court: z.object({ name: z.string().nullish() }).nullish(),
    chambers: z.array(z.object({ name: z.string() })).nullish(),
});

export const HitSchema = z.object({
    id: z.number(),
    courtType: z.string(),
    courtCases: z.array(CourtCaseSchema).nullish(),
    judgmentType: z.string().nullish(),
    judgmentDate: z.string().nullish(),
    textContent: z.string().nullish(),
    keywords: z.array(z.string()).nullish(),
    division: DivisionSchema.nullish(),
});
export type Hit = z.infer<typeof HitSchema>;

export const JudgmentSchema = HitSchema.extend({
    summary: z.string().nullish(),
    decision: z.string().nullish(),
    legalBases: z.array(z.string()).nullish(),
    referencedRegulations: z
        .array(
            z.object({
                journalTitle: z.string().nullish(),
                journalYear: z.number().nullish(),
                journalEntry: z.number().nullish(),
                text: z.string(),
            }),
        )
        .nullish(),
    source: z.object({ judgmentUrl: z.string().nullish(), publicationDate: z.string().nullish() }).nullish(),
});
export type Judgment = z.infer<typeof JudgmentSchema>;

const SearchSchema = z.object({ items: z.array(HitSchema), info: z.object({ totalResults: z.number() }).optional() });
export interface Hits {
    readonly items: Hit[];
    readonly total: number;
}

export const COURT_TYPES = ["COMMON", "SUPREME", "CONSTITUTIONAL_TRIBUNAL", "NATIONAL_APPEAL_CHAMBER", "ADMINISTRATIVE"] as const;

export interface RulingQuery {
    readonly all?: string | undefined;
    readonly legalBase?: string | undefined;
    readonly referencedRegulation?: string | undefined;
    // "1960/168": the Dz.U. year and position of a referenced act.
    readonly lawJournalEntryCode?: string | undefined;
    readonly caseNumber?: string | undefined;
    readonly courtType?: string | undefined;
    readonly judgmentDateFrom?: string | undefined;
    readonly judgmentDateTo: string;
    readonly pageSize: number;
}

const SAOS_API = "https://www.saos.org.pl/api";

export class Saos {
    constructor(private readonly http: Http) {}

    async search(query: RulingQuery): Promise<Hits> {
        const url = new URL(`${SAOS_API}/search/judgments`);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== "") {
                url.searchParams.set(key, String(value));
            }
        }
        url.searchParams.set("sortingField", "JUDGMENT_DATE");
        url.searchParams.set("sortingDirection", "DESC");
        const page = await this.http.json(url.toString(), SearchSchema);
        return { items: page.items, total: page.info?.totalResults ?? page.items.length };
    }

    async judgment(id: number): Promise<Judgment> {
        return (await this.http.json(`${SAOS_API}/judgments/${String(id)}`, z.object({ data: JudgmentSchema }))).data;
    }
}
