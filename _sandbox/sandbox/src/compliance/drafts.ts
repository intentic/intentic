import type {
    ComplianceDocumentKind,
    ComplianceLanguage,
    ComplianceReport,
    DataFlow,
    Measure,
    MeasureCategory,
    RetentionSettings,
} from "@intentic/sandbox-contract";
import { type Words, wordsFor } from "./compliance-text.js";
import type { ComplianceFacts } from "./facts.js";

// The three documents a data protection officer files before the sandbox handles anyone's data, as Markdown: the
// record of processing activities entry (GDPR Art. 30), the data protection impact assessment draft (Art. 35) and the
// technical and organisational measures (Art. 32). Everything the configuration knows is filled in; what only the
// office knows (who the controller is, why it processes, on what legal basis, whose data) is a marked blank, never a
// guess. They are a draft to be completed and signed, which each says on its first lines.

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

const table = (head: readonly string[], rows: readonly (readonly string[])[]): string =>
    [`| ${head.map(cell).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");

const list = (items: readonly string[]): string => items.map((item) => `- ${item}`).join("\n");

const CATEGORY_ORDER: readonly MeasureCategory[] = ["confidentiality", "minimisation", "integrity", "accountability", "transparency", "availability"];

const RETENTION_KEYS = ["transcriptDays", "restorePointDays", "privacyVaultDays", "cacheDays", "rawOutputDays"] as const satisfies readonly (keyof RetentionSettings)[];

interface Context {
    readonly facts: ComplianceFacts;
    readonly report: ComplianceReport;
    readonly w: Words;
    readonly pl: boolean;
    readonly date: string;
}

const activeFlows = (context: Context): DataFlow[] => context.report.flows.filter((flow) => flow.active);

// Who receives a path's data, in the document's words: the operator and its hosts where the code knows them; the web
// paths reach whichever site the agent chooses, and search rides the model provider's own traffic.
const destination = (flow: DataFlow, w: Words): string => {
    if (flow.kind === "web-search") {
        return w.anyProvider;
    }
    if (flow.hosts.length === 0 && flow.operator === undefined && (flow.kind === "web-fetch" || flow.kind === "browser")) {
        return w.anySite;
    }
    const hosts = flow.hosts.length === 0 ? "" : ` (${flow.hosts.join(", ")})`;
    return `${flow.operator ?? flow.name}${hosts}`;
};

const regionOf = (flow: DataFlow, w: Words): string => {
    if (flow.region !== undefined) {
        return flow.region;
    }
    if (flow.question !== undefined) {
        return w.blank(w.questions[flow.question] ?? flow.question);
    }
    return flow.group === "web" ? w.various : w.unknown;
};

const flowRows = (context: Context): string[][] =>
    activeFlows(context).map((flow) => [
        context.w.flowKind[flow.kind],
        destination(flow, context.w),
        regionOf(flow, context.w),
        context.w.flowData[flow.kind],
        context.w.reach[flow.personalData],
        context.w.shield[flow.shield],
    ]);

const flowTable = (context: Context): string =>
    table(
        context.pl
            ? ["Ścieżka", "Odbiorca (adresy)", "Region", "Jakie dane", "Dane osobowe", "Osłona prywatności"]
            : ["Path", "Recipient (hosts)", "Region", "What data", "Personal data", "Privacy shield"],
        flowRows(context),
    );

const retentionLabels = (pl: boolean): Readonly<Record<(typeof RETENTION_KEYS)[number], string>> =>
    pl
        ? {
              transcriptDays: "Zapisy rozmów z agentem",
              restorePointDays: "Punkty przywracania przestrzeni roboczej",
              privacyVaultDays: "Pamięć osłony prywatności (wartości i ich tokeny)",
              cacheDays: "Kopie dokumentów przekonwertowanych na tekst (PDF, pliki biurowe, skany)",
              rawOutputDays: "Pełne wyniki poleceń",
          }
        : {
              transcriptDays: "Agent conversation transcripts",
              restorePointDays: "Workspace restore points",
              privacyVaultDays: "The privacy shield's memory (values and their tokens)",
              cacheDays: "Documents converted to text (PDFs, office files, scans)",
              rawOutputDays: "Full command output",
          };

const retentionTable = (context: Context): string => {
    const labels = retentionLabels(context.pl);
    const days = (value: number): string => (value === 0 ? context.w.forever : context.w.days(value));
    return table(context.pl ? ["Dane", "Termin usunięcia"] : ["Data", "Deleted after"], [
        ...RETENTION_KEYS.map((key) => [labels[key], days(context.facts.settings.retention[key])]),
        [context.pl ? "Dziennik zdarzeń (audyt)" : "Audit trail", context.w.days(context.facts.settings.audit.retentionDays)],
    ]);
};

type Detail = (measure: Measure, context: Context) => string;

const count = (measure: Measure, key: string): string => String(measure.facts[key] ?? 0);
const PRIVACY_MODE_PL = { off: "wyłączona", watch: "obserwacja", on: "maskowanie" } as const;
const JUDGE_MODE_PL = { off: "wyłączona", watch: "obserwacja", on: "rozstrzyga" } as const;
const heldDetail = (pl: boolean): Detail => (measure) =>
    pl ? `zatwierdzane: ${count(measure, "held")} z ${count(measure, "of")}` : `held: ${count(measure, "held")} of ${count(measure, "of")}`;
const retentionDetail: Detail = (_measure, { facts }) =>
    RETENTION_KEYS.map((key) => (facts.settings.retention[key] === 0 ? "∞" : String(facts.settings.retention[key]))).join(" / ");
const auditDetail: Detail = (_measure, { facts, w }) => w.days(facts.settings.audit.retentionDays);

// The configured values behind a measure, in words; only where a number or a mode says more than the status does.
const DETAILS_PL = new Map<Measure["id"], Detail>([
    ["privacy-shield", (_measure, { facts }) => `tryb: ${PRIVACY_MODE_PL[facts.privacy.mode]}`],
    ["trusted-providers", (_measure, { facts }) => `zaufanych dostawców: ${facts.privacy.trusted.length}`],
    ["local-models", (measure) => `modele lokalne: ${count(measure, "local")}`],
    ["member-roles", (_measure, { facts }) => `osób z dostępem: ${facts.members.total}, w tym gości: ${facts.members.guests}`],
    ["action-rules", heldDetail(true)],
    ["admission", heldDetail(true)],
    ["command-judge", (_measure, { facts }) => `tryb: ${JUDGE_MODE_PL[facts.settings.commandJudge]}`],
    ["audit", auditDetail],
    ["retention", retentionDetail],
    ["agent-domain", (_measure, { facts }) => (facts.agentDomain === "unprivileged" ? "konto bez uprawnień" : "konto administratora (root)")],
]);
const DETAILS_EN = new Map<Measure["id"], Detail>([
    ["privacy-shield", (_measure, { facts }) => `mode: ${facts.privacy.mode}`],
    ["trusted-providers", (_measure, { facts }) => `trusted providers: ${facts.privacy.trusted.length}`],
    ["local-models", (measure) => `local models: ${count(measure, "local")}`],
    ["member-roles", (_measure, { facts }) => `members: ${facts.members.total}, guests: ${facts.members.guests}`],
    ["action-rules", heldDetail(false)],
    ["admission", heldDetail(false)],
    ["command-judge", (_measure, { facts }) => `mode: ${facts.settings.commandJudge}`],
    ["audit", auditDetail],
    ["retention", retentionDetail],
    ["agent-domain", (_measure, { facts }) => (facts.agentDomain === "unprivileged" ? "unprivileged account" : "root")],
]);

const measureDetail = (measure: Measure, context: Context): string => (context.pl ? DETAILS_PL : DETAILS_EN).get(measure.id)?.(measure, context) ?? "";

const measuresTable = (context: Context, measures: readonly Measure[]): string =>
    table(
        context.pl ? ["Środek", "Na czym polega", "Stan", "Szczegóły", "Gdzie się zmienia"] : ["Measure", "What it does", "Status", "Details", "Where it is changed"],
        measures.map((measure) => {
            const words = context.w.measure[measure.id];
            const status = measure.status === "unknown" ? context.w.blank(context.w.status.unknown) : context.w.status[measure.status];
            return [words.name, words.what, status, measureDetail(measure, context), words.where];
        }),
    );

const header = (context: Context, title: string): string => {
    const { pl, date, facts } = context;
    const version = facts.version === "" ? "" : pl ? `, wersja ${facts.version}` : `, version ${facts.version}`;
    return [
        `# ${title}`,
        "",
        pl
            ? `> Projekt przygotowany automatycznie ${date} na podstawie bieżącej konfiguracji systemu Intentic${version}. Pola oznaczone ✎ uzupełnia urząd. Dokument wymaga weryfikacji przez inspektora ochrony danych i zatwierdzenia przez administratora; nie jest poradą prawną.`
            : `> Drafted automatically on ${date} from the current configuration of the Intentic system${version}. Fields marked ✎ are for the office to complete. The document must be reviewed by the data protection officer and approved by the controller; it is not legal advice.`,
        "",
    ].join("\n");
};

const thirdCountryRows = (context: Context): string[][] =>
    activeFlows(context)
        .filter((flow) => flow.thirdCountry === true && flow.personalData !== "no")
        .map((flow) => [
            destination(flow, context.w),
            flow.region ?? context.w.unknown,
            context.w.shield[flow.shield],
            context.w.blank(context.pl ? "podstawa przekazania (decyzja stwierdzająca odpowiedni stopień ochrony, np. EU-US DPF, lub standardowe klauzule umowne)" : "transfer mechanism (adequacy decision such as the EU-US DPF, or standard contractual clauses)"),
        ]);

const ropa = (context: Context): string => {
    const { pl, w } = context;
    // A website the agent opens is not a recipient the office contracts with, so the web paths are said in a line below
    // the table rather than listed as processors.
    const recipients = activeFlows(context).filter((flow) => flow.personalData !== "no" && flow.shield !== "local" && flow.group !== "web");
    const web = activeFlows(context).some((flow) => flow.group === "web");
    const thirdCountries = thirdCountryRows(context);
    const onMeasures = context.report.measures.filter((measure) => measure.status === "on" || measure.status === "partial");
    if (pl) {
        return [
            header(context, "Rejestr czynności przetwarzania – wpis dla systemu Intentic (art. 30 ust. 1 RODO)"),
            "## 1. Nazwa czynności przetwarzania",
            `Przetwarzanie danych osobowych z użyciem asystenta AI (system Intentic) – ${w.blank("nazwa czynności w rejestrze urzędu, np. „przygotowywanie projektów pism”")}`,
            "",
            "## 2. Administrator danych",
            `Nazwa i dane kontaktowe administratora: ${w.blank("nazwa urzędu, adres, e-mail")}`,
            "",
            `Współadministrator (jeśli dotyczy): ${w.blank("nazwa i dane kontaktowe albo „nie dotyczy”")}`,
            "",
            "## 3. Inspektor ochrony danych",
            `Imię i nazwisko, dane kontaktowe: ${w.blank("dane kontaktowe IOD")}`,
            "",
            "## 4. Cel przetwarzania",
            w.blank("cel, np. przygotowywanie projektów odpowiedzi na wnioski, streszczanie dokumentacji, obsługa zapytań interesantów"),
            "",
            "## 5. Podstawa prawna",
            w.blank("art. 6 ust. 1 lit. c lub e RODO wraz z przepisem szczególnym; przy danych szczególnych kategorii – art. 9 ust. 2 RODO"),
            "",
            "## 6. Kategorie osób, których dane dotyczą",
            w.blank("np. interesanci, wnioskodawcy, pracownicy urzędu, kontrahenci"),
            "",
            "## 7. Kategorie danych osobowych",
            w.blank("kategorie danych przetwarzanych w tej czynności"),
            "",
            "Osłona prywatności systemu rozpoznaje i maskuje następujące kategorie danych: imiona i nazwiska, numer PESEL, NIP, numery dokumentów tożsamości, numery rachunków bankowych, numery kart płatniczych, adresy e-mail, numery telefonów, adresy.",
            "",
            "## 8. Kategorie odbiorców, w tym podmioty przetwarzające",
            recipients.length === 0
                ? "Przy obecnej konfiguracji dane osobowe nie są przekazywane poza serwer."
                : table(
                      ["Odbiorca", "Rola", "Zakres danych", "Umowa powierzenia (art. 28 RODO)"],
                      recipients.map((flow) => [
                          `${w.flowKind[flow.kind]}: ${destination(flow, w)}`,
                          "podmiot przetwarzający lub dalszy podmiot przetwarzający",
                          w.flowData[flow.kind],
                          w.blank("numer i data umowy"),
                      ]),
                  ),
            "",
            ...(web
                ? [
                      "Agent może też otwierać strony internetowe i wyszukiwać informacje; treść zapytań i adresy trafiają wtedy do wybranych serwisów oraz do dostawcy modelu. Zasady, czego nie wolno wpisywać w takie zapytania, określa urząd.",
                      "",
                  ]
                : []),
            "## 9. Przekazanie danych do państwa trzeciego lub organizacji międzynarodowej",
            thirdCountries.length === 0
                ? "Przy obecnej konfiguracji dane osobowe nie są przekazywane do państw spoza Europejskiego Obszaru Gospodarczego."
                : table(["Odbiorca", "Państwo / region", "Zabezpieczenie techniczne", "Podstawa przekazania"], thirdCountries),
            "",
            "## 10. Planowane terminy usunięcia danych",
            retentionTable(context),
            "",
            "## 11. Ogólny opis technicznych i organizacyjnych środków bezpieczeństwa (art. 32 ust. 1 RODO)",
            list(onMeasures.map((measure) => w.measure[measure.id].name)),
            "",
            "Szczegółowy wykaz zawiera dokument „Środki techniczne i organizacyjne”.",
            "",
        ].join("\n");
    }
    return [
        header(context, "Record of processing activities – entry for the Intentic system (GDPR Art. 30(1))"),
        "## 1. Name of the processing activity",
        `Processing personal data with an AI assistant (the Intentic system) – ${w.blank("the activity's name in the office's record, e.g. “drafting letters”")}`,
        "",
        "## 2. Controller",
        `Name and contact details of the controller: ${w.blank("office name, address, email")}`,
        "",
        `Joint controller (if any): ${w.blank("name and contact details, or “not applicable”")}`,
        "",
        "## 3. Data protection officer",
        `Name and contact details: ${w.blank("DPO contact details")}`,
        "",
        "## 4. Purposes of the processing",
        w.blank("the purpose, e.g. drafting replies to applications, summarising case files, answering citizens' questions"),
        "",
        "## 5. Legal basis",
        w.blank("GDPR Art. 6(1)(c) or (e) with the specific provision of law; for special categories, Art. 9(2)"),
        "",
        "## 6. Categories of data subjects",
        w.blank("e.g. citizens, applicants, staff, contractors"),
        "",
        "## 7. Categories of personal data",
        w.blank("the categories of data processed in this activity"),
        "",
        "The system's privacy shield recognises and masks these categories: names, PESEL numbers, tax numbers (NIP), identity document numbers, bank account numbers, payment card numbers, email addresses, phone numbers, addresses.",
        "",
        "## 8. Categories of recipients, including processors",
        recipients.length === 0
            ? "As configured, personal data does not leave the server."
            : table(
                  ["Recipient", "Role", "Data", "Processing agreement (GDPR Art. 28)"],
                  recipients.map((flow) => [`${w.flowKind[flow.kind]}: ${destination(flow, w)}`, "processor or sub-processor", w.flowData[flow.kind], w.blank("agreement number and date")]),
              ),
        "",
        ...(web
            ? [
                  "The agent can also open websites and search; the queries and addresses then reach the sites chosen and the model provider. The office sets the rules for what must not be typed into them.",
                  "",
              ]
            : []),
        "## 9. Transfers to a third country or an international organisation",
        thirdCountries.length === 0
            ? "As configured, personal data is not transferred outside the European Economic Area."
            : table(["Recipient", "Country / region", "Technical safeguard", "Transfer mechanism"], thirdCountries),
        "",
        "## 10. Time limits for erasure",
        retentionTable(context),
        "",
        "## 11. General description of technical and organisational security measures (GDPR Art. 32(1))",
        list(onMeasures.map((measure) => w.measure[measure.id].name)),
        "",
        "The document “Technical and organisational measures” lists them in detail.",
        "",
    ].join("\n");
};

const measureById = (context: Context, id: Measure["id"]): Measure | undefined => context.report.measures.find((measure) => measure.id === id);

// One risk's mitigations as the configuration has them: each named measure with its status, so a mitigation that is
// only available reads as such rather than as in place.
const mitigations = (context: Context, ids: readonly Measure["id"][]): string =>
    ids
        .flatMap((id) => {
            const measure = measureById(context, id);
            return measure === undefined ? [] : [`${context.w.measure[id].name} (${context.w.status[measure.status]})`];
        })
        .join("; ");

interface Risk {
    readonly pl: readonly [string, string];
    readonly en: readonly [string, string];
    readonly measures: readonly Measure["id"][];
}

const RISKS: readonly Risk[] = [
    {
        pl: ["Błędne lub zmyślone odpowiedzi modelu (halucynacje)", "Pismo lub decyzja oparte na nieprawdziwej informacji naruszają zasadę prawidłowości danych (art. 5 ust. 1 lit. d RODO)."],
        en: ["Wrong or invented answers (hallucination)", "A letter or decision based on false information breaches the accuracy principle (GDPR Art. 5(1)(d))."],
        measures: ["ai-notice", "action-rules", "command-judge"],
    },
    {
        pl: ["Ujawnienie danych dostawcy modelu", "Treść z danymi osobowymi trafia do dostawcy modelu, także poza EOG."],
        en: ["Disclosure to model providers", "Text holding personal data reaches a model provider, possibly outside the EEA."],
        measures: ["privacy-shield", "privacy-images", "privacy-names", "trusted-providers", "local-models"],
    },
    {
        pl: ["Nadmierne przechowywanie", "Zapisy rozmów, kopie dokumentów i pamięć systemu przechowywane dłużej, niż wymaga cel (art. 5 ust. 1 lit. e RODO)."],
        en: ["Excessive retention", "Transcripts, document copies and the system's memory kept longer than the purpose needs (GDPR Art. 5(1)(e))."],
        measures: ["retention"],
    },
    {
        pl: ["Nieuprawniony dostęp", "Osoba bez uprawnień odczytuje lub zmienia dane, ustawienia lub poświadczenia."],
        en: ["Unauthorised access", "Someone without the right reads or changes data, settings or credentials."],
        measures: ["sign-in", "member-roles", "areas", "guest-jail", "credential-gates", "host-guards", "encryption-at-rest", "encryption-in-transit", "audit", "audit-reads", "audit-forward"],
    },
    {
        pl: [
            "Zautomatyzowane podejmowanie decyzji (art. 22 RODO)",
            "Rozstrzygnięcie wywołujące skutki prawne wobec osoby zapada bez udziału człowieka, np. odpowiedź wysłana interesantowi bez przeglądu.",
        ],
        en: ["Automated decision-making (GDPR Art. 22)", "A decision with legal effect on a person is taken without a human, e.g. a reply sent to a citizen unreviewed."],
        measures: ["admission", "action-rules", "webchat-ai-disclosure"],
    },
    {
        pl: ["Wyciek przez kanały wychodzące", "Agent wysyła dane komunikatorem, pocztą lub do usługi zewnętrznej, do której nie powinny trafić."],
        en: ["Leaks through outward channels", "The agent sends data by messaging app, email or to an outside service where it should not go."],
        measures: ["action-rules", "host-guards", "credential-gates", "agent-domain"],
    },
];

const dpia = (context: Context): string => {
    const { pl, w, facts } = context;
    const blankCell = w.blank(pl ? "ocena" : "assessment");
    const riskTable = table(
        pl
            ? ["Ryzyko", "Opis", "Prawdopodobieństwo i waga", "Zastosowane środki (stan z konfiguracji)", "Ryzyko szczątkowe"]
            : ["Risk", "Description", "Likelihood and severity", "Measures applied (as configured)", "Residual risk"],
        RISKS.map((risk) => {
            const [name, description] = pl ? risk.pl : risk.en;
            return [name, description, blankCell, mitigations(context, risk.measures), blankCell];
        }),
    );
    const providers = facts.providers.filter((provider) => provider.connected).map((provider) => provider.label);
    const system = pl
        ? [
              "Intentic to środowisko pracy z agentami AI: pracownik zleca zadanie w rozmowie, a agent (model językowy) czyta i tworzy dokumenty w przestrzeni roboczej, korzysta z połączonych usług i odpowiada. System działa w kontenerze na serwerze wskazanym przez urząd.",
              "",
              `- Modele AI połączone obecnie: ${providers.length === 0 ? w.none : providers.join(", ")}.`,
              `- Osłona prywatności: ${measureDetail(measureById(context, "privacy-shield") ?? context.report.measures[0]!, context)}.`,
              `- Osoby z dostępem: ${facts.members.total}.`,
              "",
              "### Przepływy danych",
              flowTable(context),
          ]
        : [
              "Intentic is a workspace for AI agents: a member asks for something in a conversation, and the agent (a language model) reads and writes documents in the workspace, uses the connected services, and answers. It runs in a container on a server the office chooses.",
              "",
              `- AI models connected now: ${providers.length === 0 ? w.none : providers.join(", ")}.`,
              `- Privacy shield: ${measureDetail(measureById(context, "privacy-shield") ?? context.report.measures[0]!, context)}.`,
              `- People with access: ${facts.members.total}.`,
              "",
              "### Data flows",
              flowTable(context),
          ];
    if (pl) {
        return [
            header(context, "Ocena skutków dla ochrony danych (DPIA) – projekt (art. 35 RODO)"),
            "Przetwarzanie danych obywateli z użyciem systemów sztucznej inteligencji znajduje się w wykazie rodzajów operacji wymagających oceny skutków, ogłoszonym przez Prezesa UODO (M.P. 2019 poz. 666).",
            "",
            "## 1. Systematyczny opis operacji przetwarzania",
            ...system,
            "",
            `Cel przetwarzania: ${w.blank("cel, zgodnie z rejestrem czynności przetwarzania")}`,
            "",
            "## 2. Ocena niezbędności i proporcjonalności",
            list([
                `Czy cel można osiągnąć bez użycia AI lub z mniejszym zakresem danych? ${w.blank("uzasadnienie")}`,
                `Podstawa prawna i jej adekwatność: ${w.blank("art. 6 / art. 9 RODO, przepis szczególny")}`,
                `Minimalizacja danych: jakie dane są niezbędne, jakie pracownicy mają pomijać? ${w.blank("zasady dla pracowników")}`,
                `Prawidłowość danych: kto i jak sprawdza wynik pracy agenta przed użyciem? ${w.blank("procedura weryfikacji")}`,
                "Ograniczenie przechowywania: terminy usunięcia skonfigurowane w systemie zawiera tabela poniżej.",
                `Informacja dla osób (art. 13 i 14 RODO): ${w.blank("jak i gdzie osoby są informowane o przetwarzaniu z użyciem AI")}`,
                `Realizacja praw osób (dostęp, sprostowanie, usunięcie, sprzeciw): ${w.blank("procedura")}`,
                `Podmioty przetwarzające (art. 28 RODO) i przekazania do państw trzecich (rozdział V RODO): ${w.blank("umowy powierzenia i podstawy przekazania; odbiorców wymienia rejestr czynności przetwarzania")}`,
            ]),
            "",
            retentionTable(context),
            "",
            "## 3. Ocena ryzyka naruszenia praw lub wolności osób",
            riskTable,
            "",
            "## 4. Akt w sprawie sztucznej inteligencji (rozporządzenie (UE) 2024/1689)",
            "Używanie systemu do pomocy w redagowaniu pism, streszczaniu i wyszukiwaniu informacji nie stanowi samo w sobie zastosowania wysokiego ryzyka. Gdyby jednak system służył do oceny, czy osobom przysługują świadczenia lub usługi publiczne, albo do przyznawania, ograniczania, cofania lub żądania zwrotu takich świadczeń, byłby to system wysokiego ryzyka (załącznik III pkt 5 lit. a), z obowiązkami podmiotu stosującego, w tym oceną skutków dla praw podstawowych (art. 27). Pracownicy korzystający z systemu powinni mieć odpowiednią wiedzę o AI (art. 4), a osoby rozmawiające z czatem – informację, że rozmawiają z AI (art. 50 ust. 1).",
            "",
            `Zakres użycia w urzędzie: ${w.blank("potwierdzenie, że system nie służy do rozstrzygania o świadczeniach publicznych, albo opis takiego użycia")}`,
            "",
            "## 5. Opinia inspektora ochrony danych",
            w.blank("opinia IOD, data"),
            "",
            "## 6. Decyzja administratora",
            w.blank("czy ryzyko szczątkowe jest akceptowalne; czy wymagana jest uprzednia konsultacja z Prezesem UODO (art. 36 RODO); data i podpis"),
            "",
            `Termin przeglądu oceny: ${w.blank("data, nie rzadziej niż przy każdej istotnej zmianie konfiguracji")}`,
            "",
        ].join("\n");
    }
    return [
        header(context, "Data protection impact assessment (DPIA) – draft (GDPR Art. 35)"),
        "Processing citizens' data with artificial intelligence is on the list of processing operations requiring an impact assessment published by the President of the Polish data protection authority (UODO, M.P. 2019 item 666).",
        "",
        "## 1. Systematic description of the processing",
        ...system,
        "",
        `Purpose: ${w.blank("the purpose, as in the record of processing activities")}`,
        "",
        "## 2. Necessity and proportionality",
        list([
            `Could the purpose be met without AI, or with less data? ${w.blank("justification")}`,
            `Legal basis and its adequacy: ${w.blank("GDPR Art. 6 / Art. 9, specific provision")}`,
            `Data minimisation: which data is needed, and what staff must leave out? ${w.blank("rules for staff")}`,
            `Accuracy: who checks the agent's work before it is used, and how? ${w.blank("review procedure")}`,
            "Storage limitation: the deletion periods configured in the system are in the table below.",
            `Informing people (GDPR Art. 13 and 14): ${w.blank("how and where people are told about processing with AI")}`,
            `Data subjects' rights (access, rectification, erasure, objection): ${w.blank("procedure")}`,
            `Processors (GDPR Art. 28) and third-country transfers (GDPR Chapter V): ${w.blank("processing agreements and transfer mechanisms; the record of processing lists the recipients")}`,
        ]),
        "",
        retentionTable(context),
        "",
        "## 3. Risks to the rights and freedoms of data subjects",
        riskTable,
        "",
        "## 4. The AI Act (Regulation (EU) 2024/1689)",
        "Using the system to help draft letters, summarise and find information is not in itself a high-risk use. Were it used to evaluate whether people are eligible for public assistance benefits and services, or to grant, reduce, revoke or reclaim them, it would be a high-risk system (Annex III, point 5(a)), with the deployer's obligations including a fundamental rights impact assessment (Art. 27). Staff using the system need sufficient AI literacy (Art. 4), and people chatting with it must be told they are talking to an AI (Art. 50(1)).",
        "",
        `Use in the office: ${w.blank("confirmation that the system does not decide on public benefits, or a description of such use")}`,
        "",
        "## 5. Data protection officer's opinion",
        w.blank("the DPO's opinion, date"),
        "",
        "## 6. Controller's decision",
        w.blank("whether the residual risk is acceptable; whether prior consultation with the supervisory authority is needed (GDPR Art. 36); date and signature"),
        "",
        `Next review: ${w.blank("date, and at the latest on any significant change of configuration")}`,
        "",
    ].join("\n");
};

const toms = (context: Context): string => {
    const { pl, w } = context;
    const sections = CATEGORY_ORDER.flatMap((category) => {
        const measures = context.report.measures.filter((measure) => measure.category === category);
        return measures.length === 0 ? [] : [`## ${w.category[category]}`, measuresTable(context, measures), ""];
    });
    const organisational = pl
        ? [
              "## Środki organizacyjne (uzupełnia urząd)",
              list([
                  `Upoważnienia do przetwarzania danych dla osób z dostępem do systemu: ${w.blank("tak / nie, odesłanie do rejestru upoważnień")}`,
                  `Szkolenie pracowników z korzystania z AI i ochrony danych: ${w.blank("data i zakres")}`,
                  `Zasady korzystania z systemu (czego nie wklejać, kiedy weryfikować wynik): ${w.blank("odesłanie do zarządzenia lub instrukcji")}`,
                  `Procedura zgłaszania naruszeń ochrony danych (art. 33 i 34 RODO): ${w.blank("odesłanie do procedury")}`,
                  `Kopie zapasowe i ich ochrona: ${w.blank("częstotliwość, miejsce, szyfrowanie, test odtwarzania")}`,
                  `Przegląd uprawnień i dziennika zdarzeń: ${w.blank("kto i jak często")}`,
              ]),
          ]
        : [
              "## Organisational measures (for the office to complete)",
              list([
                  `Authorisations to process data for everyone with access: ${w.blank("yes / no, reference to the register of authorisations")}`,
                  `Staff training on AI use and data protection: ${w.blank("date and scope")}`,
                  `Rules for using the system (what not to paste, when to check results): ${w.blank("reference to the internal rule or instruction")}`,
                  `Data breach procedure (GDPR Art. 33 and 34): ${w.blank("reference to the procedure")}`,
                  `Backups and their protection: ${w.blank("frequency, location, encryption, restore test")}`,
                  `Review of permissions and the audit trail: ${w.blank("who and how often")}`,
              ]),
          ];
    return [
        header(context, pl ? "Środki techniczne i organizacyjne (art. 32 RODO) – system Intentic" : "Technical and organisational measures (GDPR Art. 32) – the Intentic system"),
        ...sections,
        ...organisational,
        "",
        pl ? "## Przepływy danych" : "## Data flows",
        flowTable(context),
        "",
    ].join("\n");
};

const FILENAMES = {
    pl: { ropa: "rejestr-czynnosci-przetwarzania", dpia: "ocena-skutkow-dpia", toms: "srodki-techniczne-i-organizacyjne" },
    en: { ropa: "record-of-processing", dpia: "dpia-draft", toms: "technical-and-organisational-measures" },
} as const satisfies Record<ComplianceLanguage, Record<ComplianceDocumentKind, string>>;

export const documentFilename = (kind: ComplianceDocumentKind, language: ComplianceLanguage): string => FILENAMES[language][kind];

export const renderDocument = (
    facts: ComplianceFacts,
    report: ComplianceReport,
    kind: ComplianceDocumentKind,
    language: ComplianceLanguage,
): string => {
    const context: Context = { facts, report, w: wordsFor(language), pl: language === "pl", date: report.generatedAt.slice(0, 10) };
    switch (kind) {
        case "ropa":
            return ropa(context);
        case "dpia":
            return dpia(context);
        case "toms":
            return toms(context);
    }
};
