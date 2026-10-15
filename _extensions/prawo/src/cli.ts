import { errorMessage } from "@intentic/base/errors";
import { type Args, dateOf, flag, has, limitOf, parseArgs, UsageError } from "./args.js";
import type { Law, Text } from "./law/law.js";
import {
    articleMarkdown,
    outlineMarkdown,
    rulingJson,
    rulingMarkdown,
    rulingsJson,
    rulingsMarkdown,
    searchJson,
    searchMarkdown,
    type Selection,
    statusJson,
    statusMarkdown,
    textJson,
    textMarkdown,
} from "./render.js";
import { actId } from "./sources/eli.js";
import type { COURT_TYPES } from "./sources/saos.js";
import { type Article, articleKey, findArticle, notesFor, parseAddress, selectUnits } from "./text/model.js";

/* `prawo`: the commands, each a call into Law and a view of its answer. The agent-CLI contract of this repository:
   everything, errors included, goes to stdout (an agent drops stderr and would read a failure as an empty answer);
   exit 0 is an answer, an empty one included, and 2 is anything else. */

const USAGE = `prawo — Polish acts (Sejm ELI: Dziennik Ustaw, Monitor Polski) and court rulings (SAOS), with citations.

  prawo search <words of the title> [--keyword K] [--type Ustawa|Rozporządzenie|…] [--year YYYY]
               [--publisher DU|MP] [--in-force | --repealed] [--limit N]
  prawo show <DU/2010/1131>                in force?, newest consolidated text, amendments after it
  prawo article <DU/1960/168> <35 § 1>     one article or a unit of it ("31 ust. 2 pkt 3", "22[1]", "§ 4" in a regulation)
  prawo text <DU/1960/168> [--from 35] [--to 38] [--all]   a long act prints its outline unless narrowed or --all
      --original    the act as first published, not the consolidated text
      --unified     the Chancellery's unified text: current, but without legal force
  prawo rulings search <phrase> [--act DU/1960/168] [--regulation "art. 35"] [--legal-base TEXT]
                       [--case "I ACa 772/13"] [--court common|supreme|tribunal|kio] [--from DATE] [--to DATE] [--limit N]
  prawo rulings show <SAOS id> [--full]

  --json      the same facts as JSON
  --refresh   ask the sources again instead of the cached copy
Texts are kept in the workspace cache, so an act read once can be quoted offline.`;

export interface Output {
    readonly code: number;
    readonly text: string;
}

export interface Settings {
    readonly limit: number;
    readonly today: string;
}

const print = <T>(args: Args, json: () => T, markdown: () => string): string => (has(args, "json") ? JSON.stringify(json(), undefined, 1) : markdown());

const required = (value: string | undefined, what: string): string => {
    if (value === undefined || value.trim() === "") {
        throw new UsageError(`${what} is required (prawo --help)`);
    }
    return value;
};

const search = async (args: Args, law: Law, settings: Settings): Promise<string> => {
    const title = args.positional.slice(1).join(" ");
    const keyword = flag(args, "keyword");
    if (title === "" && keyword === undefined) {
        throw new UsageError("give words of the title, or --keyword");
    }
    if (has(args, "in-force") && has(args, "repealed")) {
        throw new UsageError("--in-force and --repealed exclude each other");
    }
    const publisher = flag(args, "publisher")?.toUpperCase();
    if (publisher !== undefined && publisher !== "DU" && publisher !== "MP") {
        throw new UsageError("--publisher is DU (Dziennik Ustaw) or MP (Monitor Polski)");
    }
    const result = await law.search({
        title,
        keyword,
        publisher,
        year: flag(args, "year"),
        type: flag(args, "type"),
        inForce: has(args, "in-force"),
        repealed: has(args, "repealed"),
        limit: limitOf(args, settings.limit),
    });
    return print(args, () => searchJson(result), () => searchMarkdown(result));
};

const show = async (args: Args, law: Law): Promise<string> => {
    const status = await law.status(required(args.positional[1], "an act, e.g. DU/1960/168,"));
    return print(args, () => statusJson(status), () => statusMarkdown(status));
};

const preferOf = (args: Args): "original" | "unified" | undefined => {
    if (has(args, "original") && has(args, "unified")) {
        throw new UsageError("--original and --unified exclude each other");
    }
    return has(args, "original") ? "original" : has(args, "unified") ? "unified" : undefined;
};

const inRange = (article: Article, from: string | undefined, to: string | undefined, articles: readonly Article[]): boolean => {
    const index = articles.indexOf(article);
    const start = from === undefined ? 0 : articles.findIndex((candidate) => candidate.number === articleKey(from));
    const end = to === undefined ? articles.length - 1 : articles.findLastIndex((candidate) => candidate.number === articleKey(to));
    return index >= start && index <= end;
};

const text = async (args: Args, law: Law): Promise<string> => {
    const result = await law.text(actId(required(args.positional[1], "an act, e.g. DU/1960/168,")), preferOf(args));
    const { articles } = result.parsed;
    const from = flag(args, "from");
    const to = flag(args, "to");
    for (const bound of [from, to]) {
        if (bound !== undefined && findArticle(result.parsed, articleKey(bound)) === undefined) {
            throw new UsageError(`${bound} is not an article of ${result.edition.ELI} (prawo text without --from/--to lists them)`);
        }
    }
    const chosen = articles.filter((article) => inRange(article, from, to, articles));
    const whole = textMarkdown(result, chosen);
    // A whole code is a few hundred thousand characters: unasked, an agent gets its outline and the way to narrow it.
    const outline = from === undefined && to === undefined && !has(args, "all") && whole.length > WHOLE_TEXT_LIMIT;
    return print(
        args,
        () => textJson(result, chosen.map((article) => ({ article, units: article.units, notes: article.notes, marker: article.marker }))),
        () => (outline ? outlineMarkdown(result, chosen, whole.length) : whole),
    );
};

const WHOLE_TEXT_LIMIT = 40_000;

const selectionsOf = (result: Text, address: string): Selection[] => {
    const { article, rest } = parseAddress(address);
    const versions = result.parsed.articles.filter((candidate) => candidate.number === article);
    if (versions.length === 0) {
        const near = result.parsed.articles
            .map((candidate) => candidate.number)
            .filter((number) => number.startsWith(article.replace(/^(z[^:]*:)?(\d*).*$/u, "$1$2")))
            .slice(0, 8);
        throw new UsageError(
            `no article ${article} in ${result.edition.ELI}${near.length > 0 ? `; nearby: ${near.join(", ")}` : ""} (a repealed article may be missing from the text; prawo text ${result.status.act.ELI} lists them)`,
        );
    }
    const selections = versions.map((version) => ({
        article: version,
        units: selectUnits(version, rest),
        notes: notesFor(version, rest),
        marker: rest === "" ? version.marker : `${version.marker} ${rest}`,
    }));
    if (selections.every((selection) => selection.units.length === 0)) {
        throw new UsageError(`${selections[0]?.marker ?? address} is not in ${versions[0]?.marker ?? article}; its units are: ${(versions[0]?.units ?? []).map((unit) => unit.marker).join(", ")}`);
    }
    return selections.filter((selection) => selection.units.length > 0);
};

const article = async (args: Args, law: Law): Promise<string> => {
    const id = actId(required(args.positional[1], "an act, e.g. DU/1960/168,"));
    const address = required(args.positional.slice(2).join(" "), "an article, e.g. 35 or \"35 § 1\",");
    const result = await law.text(id, preferOf(args));
    const selections = selectionsOf(result, address);
    return print(args, () => textJson(result, selections), () => articleMarkdown(result, selections));
};

const COURTS: ReadonlyMap<string, (typeof COURT_TYPES)[number]> = new Map([
    ["common", "COMMON"],
    ["supreme", "SUPREME"],
    ["tribunal", "CONSTITUTIONAL_TRIBUNAL"],
    ["kio", "NATIONAL_APPEAL_CHAMBER"],
    ["administrative", "ADMINISTRATIVE"],
]);

const rulings = async (args: Args, law: Law, settings: Settings): Promise<string> => {
    const sub = args.positional[1];
    if (sub === "show") {
        const id = Number(required(args.positional[2], "a SAOS ruling id"));
        if (!Number.isInteger(id) || id < 1) {
            throw new UsageError(`a SAOS ruling id is a number, got "${args.positional[2] ?? ""}"`);
        }
        const judgment = await law.ruling(id);
        return print(args, () => rulingJson(judgment.value), () => rulingMarkdown(judgment.value, has(args, "full")));
    }
    if (sub !== "search") {
        throw new UsageError("use prawo rulings search <phrase> or prawo rulings show <id>");
    }
    const court = flag(args, "court");
    const courtType = court === undefined ? undefined : COURTS.get(court.toLowerCase());
    if (court !== undefined && courtType === undefined) {
        throw new UsageError(`--court is one of ${[...COURTS.keys()].join(", ")}`);
    }
    const act = flag(args, "act");
    const lawJournalEntryCode = act === undefined ? undefined : journalEntry(act);
    const all = args.positional.slice(2).join(" ");
    const legalBase = flag(args, "legal-base");
    const referencedRegulation = flag(args, "regulation");
    const caseNumber = flag(args, "case");
    if ([all, legalBase, referencedRegulation, caseNumber, lawJournalEntryCode].every((value) => value === undefined || value === "")) {
        throw new UsageError("give a phrase, or --act, --regulation, --legal-base or --case");
    }
    const hits = await law.rulings({
        all,
        legalBase,
        referencedRegulation,
        lawJournalEntryCode,
        caseNumber,
        courtType,
        judgmentDateFrom: dateOf(args, "from"),
        // Capped at today: a few records carry typo'd dates centuries ahead, which would otherwise sort first.
        judgmentDateTo: dateOf(args, "to") ?? settings.today,
        pageSize: limitOf(args, settings.limit),
    });
    return print(args, () => rulingsJson(hits.value), () => rulingsMarkdown(hits.value, hits.stale));
};

// SAOS links rulings to Dziennik Ustaw entries as "year/position"; Monitor Polski has no such link.
const journalEntry = (raw: string): string => {
    const id = actId(raw);
    if (!id.startsWith("DU/")) {
        throw new UsageError("--act links rulings through Dziennik Ustaw only (DU/<year>/<position>)");
    }
    return id.slice(3);
};

const COMMANDS: ReadonlyMap<string, (args: Args, law: Law, settings: Settings) => Promise<string>> = new Map([
    ["search", search],
    ["show", show],
    ["text", text],
    ["article", article],
    ["rulings", rulings],
]);

export const execute = async (argv: readonly string[], law: Law, settings: Settings): Promise<Output> => {
    try {
        const args = parseArgs(argv);
        const command = COMMANDS.get(args.positional[0] ?? "");
        if (command === undefined || has(args, "help")) {
            const known = args.positional[0] === undefined || has(args, "help");
            return { code: known ? 0 : 2, text: known ? USAGE : `unknown command "${args.positional[0] ?? ""}"\n\n${USAGE}` };
        }
        return { code: 0, text: await command(args, law, settings) };
    } catch (error) {
        return { code: 2, text: `prawo: ${errorMessage(error)}` };
    }
};
