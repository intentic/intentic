import type {
    ComplianceLanguage,
    DataFlowKind,
    MeasureId,
    MeasureStatus,
    PersonalDataReach,
    ShieldCover,
} from "@intentic/sandbox-contract/schemas/compliance";

// The words the compliance documents are written in, Polish first: the readers are a Polish office's data protection
// officer (IOD) and its clerks, so the Polish is written as such a document is, in the terms of the Polish text of the
// GDPR (RODO), not translated from the English. The editor words the same kinds in its own catalogs; these are only
// the documents'.

export interface Words {
    readonly blank: (what: string) => string;
    readonly yes: string;
    readonly no: string;
    readonly unknown: string;
    readonly none: string;
    readonly various: string;
    readonly anySite: string;
    readonly anyProvider: string;
    readonly status: Readonly<Record<MeasureStatus, string>>;
    readonly reach: Readonly<Record<PersonalDataReach, string>>;
    readonly shield: Readonly<Record<ShieldCover, string>>;
    readonly flowKind: Readonly<Record<DataFlowKind, string>>;
    readonly flowData: Readonly<Record<DataFlowKind, string>>;
    readonly questions: Readonly<Record<string, string>>;
    readonly measure: Readonly<Record<MeasureId, { readonly name: string; readonly what: string; readonly where: string }>>;
    readonly category: Readonly<Record<string, string>>;
    readonly days: (days: number) => string;
    readonly forever: string;
}

const PL: Words = {
    blank: (what) => `**[✎ DO UZUPEŁNIENIA: ${what}]**`,
    yes: "tak",
    no: "nie",
    unknown: "nieustalone",
    none: "brak",
    various: "różne",
    anySite: "strony internetowe wybrane przez agenta",
    anyProvider: "dostawca modelu (wbudowane narzędzie wyszukiwania)",
    status: {
        on: "wdrożone",
        partial: "wdrożone częściowo",
        off: "dostępne, niewłączone",
        unavailable: "niedostępne w tej instalacji",
        unknown: "do ustalenia przez urząd",
    },
    reach: { yes: "tak", possible: "możliwe", no: "nie" },
    shield: {
        masked: "maskowane (dane osobowe zastępowane tokenami)",
        trusted: "dostawca zaufany: dane przekazywane bez maskowania",
        watched: "tylko obserwacja: dane przekazywane bez zmian",
        local: "nie opuszczają serwera",
        blocked: "zablokowane: żądania, których nie da się zamaskować, są odrzucane",
        none: "brak ochrony osłoną",
    },
    flowKind: {
        "model-provider": "Dostawca modelu AI (subskrypcja)",
        "model-endpoint": "Zewnętrzny punkt dostępu do modelu AI",
        "local-model": "Model AI uruchomiony lokalnie",
        "email-imap": "Poczta przychodząca (IMAP)",
        "email-smtp": "Wysyłka poczty (SMTP)",
        "team-chat": "Komunikator (bot)",
        webchat: "Czat na stronie dla interesantów",
        connector: "Połączenie z usługą zewnętrzną",
        speech: "Synteza mowy w chmurze",
        "web-search": "Wyszukiwanie w internecie",
        "web-fetch": "Pobieranie stron internetowych",
        browser: "Przeglądarka agenta",
        "platform-link": "Konto i logowanie Intentic",
        ingress: "Dostęp do systemu z sieci (ingress)",
        "update-check": "Sprawdzanie aktualizacji",
        "model-download": "Pobieranie modeli",
        "product-analytics": "Analityka produktu",
        "push-notifications": "Powiadomienia push",
    },
    flowData: {
        "model-provider": "treść rozmów, polecenia, fragmenty dokumentów i plików przekazywane modelowi",
        "model-endpoint": "treść rozmów, polecenia, fragmenty dokumentów i plików przekazywane modelowi",
        "local-model": "treść rozmów i dokumentów; przetwarzane na tym samym serwerze",
        "email-imap": "treść wiadomości e-mail, nadawcy, adresaci, załączniki",
        "email-smtp": "treść wysyłanych wiadomości i adresy odbiorców",
        "team-chat": "wiadomości, nazwy i identyfikatory uczestników, załączniki",
        webchat: "wiadomości interesantów, ich imię (jeśli wymagane) i adres IP",
        connector: "dane, które agent odczytuje lub zapisuje w danej usłudze",
        speech: "tekst odpowiedzi czytany na głos",
        "web-search": "zapytania wyszukiwania sformułowane przez agenta",
        "web-fetch": "adresy pobieranych stron i parametry zapytań",
        browser: "adresy odwiedzanych stron i dane wpisywane w formularze",
        "platform-link": "adresy e-mail członków, dane logowania, stan systemu; nie treść pracy",
        ingress: "cały ruch między przeglądarką użytkownika a systemem (szyfrowanie TLS kończy się na brzegu sieci)",
        "update-check": "wersja oprogramowania; bez danych osobowych",
        "model-download": "nazwa pobieranego modelu; bez danych osobowych",
        "product-analytics": "zdarzenia w edytorze i nagrania sesji osób, które się na nie zgodziły",
        "push-notifications": "krótka treść powiadomienia",
    },
    questions: {
        "endpoint-operator": "kto prowadzi ten punkt dostępu i gdzie przetwarza dane",
        "mail-operator": "kto prowadzi serwer poczty i gdzie się on znajduje",
        "ingress-region": "czy punkt dostępowy Intentic (Fly.io), na którym kończy się szyfrowanie TLS, nadal działa wyłącznie w USA (Ashburn), jak podaje strona podmiotów przetwarzających Intentic",
        "ingress-proxy": "czy urząd udostępnia system przez własny serwer pośredniczący (reverse proxy), czy przez ingress Intentic",
        "platform-region": "gdzie platforma Intentic przechowuje dane kont",
    },
    measure: {
        "privacy-shield": {
            name: "Osłona prywatności",
            what: "Wykrywa dane osobowe (imiona i nazwiska, PESEL, NIP, numery dokumentów, rachunków, kart, e-mail, telefon, adres) i zastępuje je tokenami, zanim treść trafi do niezaufanego dostawcy modelu; odpowiedź jest odtwarzana lokalnie.",
            where: "Sandbox ▸ Osłona prywatności",
        },
        "privacy-images": {
            name: "Maskowanie danych na obrazach",
            what: "Tekst na obrazach jest odczytywany lokalnie (OCR), a znalezione dane osobowe są zamalowywane przed wysłaniem.",
            where: "Sandbox ▸ Osłona prywatności",
        },
        "privacy-names": {
            name: "Rozpoznawanie imion i nazwisk modelem lokalnym",
            what: "Oprócz słowników imion i nazwisk używany jest lokalny model rozpoznawania nazw własnych (HerBERT).",
            where: "Sandbox ▸ Osłona prywatności",
        },
        "trusted-providers": {
            name: "Lista zaufanych dostawców",
            what: "Dostawcy, którym osłona przekazuje dane bez maskowania. Pusta lista oznacza, że każdy dostawca spoza serwera otrzymuje tylko tokeny.",
            where: "Sandbox ▸ Osłona prywatności",
        },
        "local-models": {
            name: "Modele uruchamiane lokalnie",
            what: "Model działający na serwerze urzędu; dane nie opuszczają infrastruktury.",
            where: "Sandbox ▸ Modele",
        },
        "member-roles": {
            name: "Role i uprawnienia użytkowników",
            what: "Każda osoba ma rolę (właściciel, opiekun, współpracownik, autor, obserwator, gość) ograniczającą, co może zobaczyć i zrobić.",
            where: "Sandbox ▸ Dostęp",
        },
        areas: {
            name: "Obszary (ograniczenie dostępu do folderów)",
            what: "Dostęp osoby można zawęzić do wybranych folderów; reszta przestrzeni roboczej jest dla niej niewidoczna.",
            where: "Sandbox ▸ Obszary",
        },
        "guest-jail": {
            name: "Izolacja gości",
            what: "Rozmowy gości działają w odizolowanym środowisku (bubblewrap) widzącym tylko przydzielone foldery.",
            where: "Sandbox ▸ Dostęp",
        },
        "sign-in": {
            name: "Uwierzytelnianie",
            what: "Logowanie przez konto Google, klucz dostępu (passkey) lub kod jednorazowy wysyłany e-mailem, jeśli właściciel na to pozwolił.",
            where: "Sandbox ▸ Dostęp",
        },
        "action-rules": {
            name: "Zatwierdzanie działań na zewnątrz",
            what: "Wysłanie wiadomości, reakcji lub poczty oraz uruchomienie kolejnych agentów czeka na zatwierdzenie przez człowieka.",
            where: "Sandbox ▸ Bezpieczniki",
        },
        admission: {
            name: "Zatwierdzanie pracy zleconej z zewnątrz",
            what: "Praca uruchomiona przez wiadomość z komunikatora, czat na stronie, webhook lub zgłoszenie błędu czeka na zatwierdzenie.",
            where: "Sandbox ▸ Bezpieczniki",
        },
        "command-judge": {
            name: "Ocena poleceń przed wykonaniem",
            what: "Model ocenia ryzykowne polecenia agenta według polityki bezpieczeństwa urzędu i zatrzymuje je do decyzji człowieka.",
            where: "Sandbox ▸ Bezpieczniki",
        },
        "credential-gates": {
            name: "Zatwierdzanie użycia poświadczeń",
            what: "Użycie wskazanych haseł i kluczy wymaga zgody wyznaczonej osoby.",
            where: "Sandbox ▸ Sekrety",
        },
        "host-guards": {
            name: "Ograniczenie adresów dla poświadczeń",
            what: "Poświadczenie może trafić tylko pod adresy z listy; każde inne użycie wymaga zgody.",
            where: "Sandbox ▸ Sekrety",
        },
        retention: {
            name: "Terminy usuwania danych",
            what: "Zapisy rozmów, punkty przywracania, pamięć osłony prywatności, kopie dokumentów i surowe wyniki poleceń są trwale usuwane po upływie ustalonego terminu.",
            where: "Sandbox ▸ Przechowywanie danych",
        },
        audit: {
            name: "Dziennik zdarzeń (audyt)",
            what: "Zmiany polityk, uprawnień, sekretów i ustawień są zapisywane w dzienniku z łańcuchem skrótów, który ujawnia każdą zmianę lub usunięcie wpisu.",
            where: "Sandbox ▸ Przechowywanie danych",
        },
        "audit-reads": {
            name: "Rejestrowanie odczytów",
            what: "Dziennik zapisuje także, kto otworzył którą rozmowę, plik lub dziennik.",
            where: "Sandbox ▸ Dziennik zdarzeń ▸ Przechowywanie",
        },
        "audit-forward": {
            name: "Kopia dziennika poza systemem",
            what: "Każdy wpis dziennika jest równolegle wysyłany do systemu urzędu (SIEM), poza zasięgiem osób pracujących w systemie.",
            where: "Sandbox ▸ Dziennik zdarzeń ▸ Przechowywanie",
        },
        "encryption-at-rest": {
            name: "Szyfrowanie danych w spoczynku",
            what: "Sekrety, magazyn poświadczeń i pamięć osłony prywatności są szyfrowane kluczem przechowywanym poza woluminami systemu.",
            where: "zmienna środowiskowa INTENTIC_AT_REST_KEY_FILE przy uruchomieniu kontenera",
        },
        "encryption-in-transit": {
            name: "Szyfrowanie transmisji",
            what: "Połączenia z systemem są szyfrowane (TLS).",
            where: "konfiguracja ingress lub serwera pośredniczącego urzędu",
        },
        "agent-domain": {
            name: "Agent bez uprawnień administratora",
            what: "Polecenia agenta wykonywane są na koncie bez uprawnień administratora systemu.",
            where: "Sandbox ▸ Agent",
        },
        "product-analytics": {
            name: "Wyłączona analityka produktu",
            what: "Edytor nie wysyła do Intentic zdarzeń ani nagrań sesji z tej piaskownicy, niezależnie od zgód poszczególnych osób.",
            where: "Sandbox ▸ Osłona prywatności",
        },
        "ai-notice": {
            name: "Informacja o pracy z AI dla pracowników",
            what: "Przy pierwszym wejściu pracownik potwierdza, że pracuje z systemem AI, który popełnia błędy, i czego nie należy do niego wklejać (art. 4 aktu w sprawie AI).",
            where: "Sandbox ▸ Dostęp",
        },
        "webchat-ai-disclosure": {
            name: "Informacja dla interesantów, że rozmawiają z AI",
            what: "Czat na stronie informuje rozmówcę, że odpowiada mu system AI (art. 50 ust. 1 aktu w sprawie AI).",
            where: "Automatyzacje ▸ czat na stronie",
        },
        backups: {
            name: "Kopie zapasowe",
            what: "Kopie zapasowe woluminów systemu są poza wiedzą systemu: wykonuje je i chroni urząd.",
            where: "infrastruktura urzędu",
        },
    },
    category: {
        confidentiality: "Poufność",
        minimisation: "Minimalizacja danych i ograniczenie przechowywania",
        integrity: "Integralność i kontrola działań",
        accountability: "Rozliczalność",
        transparency: "Przejrzystość",
        availability: "Dostępność i odporność",
    },
    days: (days) => (days === 1 ? "1 dzień" : `${days} dni`),
    forever: "bez limitu (przechowywane bezterminowo)",
};

const EN: Words = {
    blank: (what) => `**[✎ TO BE COMPLETED: ${what}]**`,
    yes: "yes",
    no: "no",
    unknown: "not determined",
    none: "none",
    various: "various",
    anySite: "websites the agent chooses",
    anyProvider: "the model provider (its built-in search tool)",
    status: {
        on: "in place",
        partial: "partly in place",
        off: "available, not switched on",
        unavailable: "not available in this installation",
        unknown: "for the office to establish",
    },
    reach: { yes: "yes", possible: "possible", no: "no" },
    shield: {
        masked: "masked (personal data replaced with tokens)",
        trusted: "trusted provider: data sent unmasked",
        watched: "watch only: data sent unchanged",
        local: "never leaves the server",
        blocked: "blocked: requests that cannot be masked are refused",
        none: "not covered by the shield",
    },
    flowKind: {
        "model-provider": "AI model provider (subscription)",
        "model-endpoint": "External AI model endpoint",
        "local-model": "AI model run locally",
        "email-imap": "Incoming mail (IMAP)",
        "email-smtp": "Sending mail (SMTP)",
        "team-chat": "Messaging app (bot)",
        webchat: "Visitor chat on a website",
        connector: "Connection to an outside service",
        speech: "Cloud text-to-speech",
        "web-search": "Web search",
        "web-fetch": "Fetching web pages",
        browser: "The agent's browser",
        "platform-link": "Intentic account and sign-in",
        ingress: "Network access to the system (ingress)",
        "update-check": "Update checks",
        "model-download": "Model downloads",
        "product-analytics": "Product analytics",
        "push-notifications": "Push notifications",
    },
    flowData: {
        "model-provider": "conversation text, instructions, excerpts of documents and files sent to the model",
        "model-endpoint": "conversation text, instructions, excerpts of documents and files sent to the model",
        "local-model": "conversation and document text; processed on the same server",
        "email-imap": "message bodies, senders, recipients, attachments",
        "email-smtp": "the text of messages sent and their recipients' addresses",
        "team-chat": "messages, participants' names and ids, attachments",
        webchat: "visitors' messages, their name (if asked for) and IP address",
        connector: "whatever the agent reads from or writes to that service",
        speech: "the text of replies read aloud",
        "web-search": "search queries the agent writes",
        "web-fetch": "addresses and query parameters of pages fetched",
        browser: "addresses visited and what is typed into forms",
        "platform-link": "members' email addresses, sign-in data, system status; not the work itself",
        ingress: "all traffic between the user's browser and the system (TLS terminates at the network edge)",
        "update-check": "the software version; no personal data",
        "model-download": "the name of the model downloaded; no personal data",
        "product-analytics": "editor events and session recordings of people who agreed to them",
        "push-notifications": "a short notification text",
    },
    questions: {
        "endpoint-operator": "who runs this endpoint and where it processes data",
        "mail-operator": "who runs the mail server and where it is",
        "ingress-region": "whether Intentic's access point (Fly.io), where TLS ends, still runs only in the US (Ashburn), as Intentic's sub-processors page states",
        "ingress-proxy": "whether the office serves the system through its own reverse proxy or through Intentic's ingress",
        "platform-region": "where the Intentic platform stores account data",
    },
    measure: {
        "privacy-shield": {
            name: "Privacy shield",
            what: "Finds personal data (names, PESEL and tax numbers, document, bank account and card numbers, email, phone, address) and replaces it with tokens before text reaches an untrusted model provider; the answer is restored locally.",
            where: "Sandbox ▸ Privacy shield",
        },
        "privacy-images": {
            name: "Masking personal data in images",
            what: "Text in images is read locally (OCR) and personal data found in it is painted over before sending.",
            where: "Sandbox ▸ Privacy shield",
        },
        "privacy-names": {
            name: "Finding names with a local model",
            what: "Besides first-name and surname lists, a local named-entity model (HerBERT) finds names.",
            where: "Sandbox ▸ Privacy shield",
        },
        "trusted-providers": {
            name: "Trusted providers list",
            what: "Providers the shield lets read personal data unmasked. An empty list means every provider off the server reads tokens only.",
            where: "Sandbox ▸ Privacy shield",
        },
        "local-models": {
            name: "Models run locally",
            what: "A model running on the office's server; data does not leave its infrastructure.",
            where: "Sandbox ▸ Models",
        },
        "member-roles": {
            name: "User roles and permissions",
            what: "Each person has a role (owner, maintainer, collaborator, writer, viewer, guest) limiting what they can see and do.",
            where: "Sandbox ▸ Access",
        },
        areas: {
            name: "Areas (folder-level access)",
            what: "A person's access can be narrowed to chosen folders; the rest of the workspace is invisible to them.",
            where: "Sandbox ▸ Areas",
        },
        "guest-jail": {
            name: "Guest isolation",
            what: "Guests' conversations run in an isolated environment (bubblewrap) that sees only the folders granted.",
            where: "Sandbox ▸ Access",
        },
        "sign-in": {
            name: "Authentication",
            what: "Sign-in with a Google account, a passkey, or an emailed one-time code where the owner allows it.",
            where: "Sandbox ▸ Access",
        },
        "action-rules": {
            name: "Approval of outward actions",
            what: "Sending a message, reaction or email, and starting further agents, waits for a person's approval.",
            where: "Sandbox ▸ Guardrails",
        },
        admission: {
            name: "Approval of work started from outside",
            what: "Work started by a team-chat message, the website chat, a webhook or a bug report waits for approval.",
            where: "Sandbox ▸ Guardrails",
        },
        "command-judge": {
            name: "Commands judged before they run",
            what: "A model judges the agent's risky commands against the office's safety policy and holds them for a person.",
            where: "Sandbox ▸ Guardrails",
        },
        "credential-gates": {
            name: "Approval of credential use",
            what: "Using chosen passwords and keys requires a named person's consent.",
            where: "Sandbox ▸ Secrets",
        },
        "host-guards": {
            name: "Credentials limited to listed addresses",
            what: "A credential may only go to the listed addresses; any other use asks first.",
            where: "Sandbox ▸ Secrets",
        },
        retention: {
            name: "Deletion periods",
            what: "Transcripts, restore points, the privacy shield's memory, converted documents and raw command output are deleted for good after a set period.",
            where: "Sandbox ▸ Retention",
        },
        audit: {
            name: "Audit trail",
            what: "Changes to policies, permissions, secrets and settings are written to a hash-chained log that shows any changed or removed record.",
            where: "Sandbox ▸ Retention",
        },
        "audit-reads": {
            name: "Recording reads",
            what: "The audit trail also records who opened which conversation, file or log.",
            where: "Sandbox ▸ Audit log ▸ How it is kept",
        },
        "audit-forward": {
            name: "Copy of the audit trail outside the system",
            what: "Each audit record is also sent to the office's own system (SIEM), out of reach of the people working in this one.",
            where: "Sandbox ▸ Audit log ▸ How it is kept",
        },
        "encryption-at-rest": {
            name: "Encryption at rest",
            what: "Secrets, the credential vault and the privacy shield's memory are encrypted with a key kept outside the system's volumes.",
            where: "INTENTIC_AT_REST_KEY_FILE environment variable when the container starts",
        },
        "encryption-in-transit": {
            name: "Encryption in transit",
            what: "Connections to the system are encrypted (TLS).",
            where: "the ingress or the office's reverse proxy",
        },
        "agent-domain": {
            name: "Agent without administrator rights",
            what: "The agent's commands run under an account without system administrator rights.",
            where: "Sandbox ▸ Agent",
        },
        "product-analytics": {
            name: "Product analytics switched off",
            what: "The editor sends Intentic no events or session recordings from this sandbox, whatever each person agreed to.",
            where: "Sandbox ▸ Privacy shield",
        },
        "ai-notice": {
            name: "AI notice for staff",
            what: "On first entry, staff confirm they are working with an AI system that makes mistakes, and what not to paste into it (AI Act Art. 4).",
            where: "Sandbox ▸ Access",
        },
        "webchat-ai-disclosure": {
            name: "Telling visitors they are talking to an AI",
            what: "The website chat tells the person they are answered by an AI system (AI Act Art. 50(1)).",
            where: "Automations ▸ website chat",
        },
        backups: {
            name: "Backups",
            what: "Backups of the system's volumes are outside what the system can see: the office makes and protects them.",
            where: "the office's infrastructure",
        },
    },
    category: {
        confidentiality: "Confidentiality",
        minimisation: "Data minimisation and storage limitation",
        integrity: "Integrity and control of actions",
        accountability: "Accountability",
        transparency: "Transparency",
        availability: "Availability and resilience",
    },
    days: (days) => (days === 1 ? "1 day" : `${days} days`),
    forever: "no limit (kept indefinitely)",
};

export const wordsFor = (language: ComplianceLanguage): Words => (language === "pl" ? PL : EN);
