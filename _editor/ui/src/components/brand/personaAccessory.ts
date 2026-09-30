import type { AssistantAccessory } from "./assistantFaces.js";
import type { PersonaLike } from "./personaFace.js";

// WHAT A PERSONA HOLDS SAYS WHAT IT HELPS WITH, AND ITS NAME IS THE ONE THING EVERY SURFACE KNOWS. First rule that
// answers wins:
//   1. A project persona, still named after its repository, codes.
//   2. A specialty word in the name. Read from the right, since a job title ends in its head noun: a UX Writer
//      writes, a Frontend Designer designs, a Code Reviewer reviews.
//   3. A generic role word (engineer, manager, lead) only when nothing more specific was said, so a QA Engineer
//      guards quality and a Marketing Lead grows things rather than both falling to their title.
//   4. Anything else, a person's name or a repository's, codes: that is what an agent here does unless told otherwise.
// The label is the name; the id only stands in when there is no label, since a renamed persona keeps its old id.

// `word` matches that word, and the word plus a plural `s`; `stem*` matches any word it begins. English, plus the
// commonest Polish job titles, since the editor ships in Polish too. Accents are folded away before matching.
const SPECIALTIES = {
    terminal: [
        `code`, `coder`, `coding`, `dev`, `develop*`, `programmer*`, `programming`, `software`, `frontend`, `backend`,
        `fullstack`, `builder`, `build`, `maker`, `hacking`, `implement*`, `refactor*`, `api`, `sdk`, `cli`, `tech`,
        `typescript`, `javascript`, `python`, `rust`, `golang`, `java`, `react`, `vue`, `node`, `ios`, `android`,
        `mobile`, `repo`, `git`, `github`, `migration*`, `sql`, `database`, `devops`, `ops`, `infra*`, `deploy*`,
        `sysadmin`, `shell`, `server*`, `cloud`, `docker`, `kubernetes`, `k8s`, `ai`, `ml`, `llm`, `automat*`,
        `integration*`, `bugfix*`, `fixer`, `programist*`, `koder*`, `deweloper*`, `wdroz*`,
    ],
    palette: [
        `design*`, `ux`, `ui`, `uxui`, `visual*`, `brand*`, `art`, `artist*`, `artwork*`, `illustrat*`, `graphic*`,
        `figma`, `css`, `style`, `styling`, `stylist`, `typograph*`, `font`, `color*`, `colour*`, `animat*`, `motion`,
        `creative*`, `muse`, `aesthetic*`, `layout*`, `theme*`, `icon*`, `logo*`, `pixel*`, `photo*`, `video*`,
        `interface*`, `usability`, `accessib*`, `a11y`, `prototyp*`, `wireframe*`, `mockup*`, `projektant*`,
        `projektow*`, `grafik*`,
    ],
    magnifier: [
        `research*`, `analy*`, `investigat*`, `inspect*`, `explor*`, `scout*`, `detective*`, `discover*`, `insight*`,
        `search*`, `finder`, `hunt*`, `bug`, `debug*`, `diagnos*`, `triage*`, `data`, `metric*`, `stats`, `statistic*`,
        `science`, `scientist*`, `survey*`, `review*`, `factcheck*`, `crawl*`, `scrap*`, `badacz*`, `badani*`,
        `analityk*`,
    ],
    scroll: [
        `writ*`, `copy`, `copywrit*`, `author`, `authoring`, `scribe*`, `editor*`, `editorial`, `proofread*`, `blog*`,
        `content`, `article*`, `newsletter*`, `story`, `stories`, `storytell*`, `narrat*`, `journalist*`, `reporter*`,
        `speech*`, `translat*`, `localiz*`, `localis*`, `i18n`, `l10n`, `word*`, `prose`, `poet*`, `poem*`, `lyric*`,
        `email*`, `mail`, `communicat*`, `messag*`, `summar*`, `note*`, `changelog*`, `support`, `helpdesk`,
        `customer*`, `pisarz*`, `redaktor*`, `tlumacz*`, `korekt*`,
    ],
    book: [
        `learn*`, `teach*`, `tutor*`, `mentor*`, `coach*`, `educat*`, `student*`, `study`, `studies`, `studying`,
        `scholar*`, `school`, `course*`, `lesson*`, `trainer*`, `training`, `onboard*`, `explain*`, `professor*`,
        `academ*`, `knowledge`, `wiki*`, `doc`, `document*`, `manual*`, `handbook*`, `librar*`, `reader`, `reading`,
        `quiz*`, `archiv*`, `faq`, `accountant*`, `accounting`, `bookkeep*`, `ledger*`, `invoice*`, `finance*`,
        `financial`, `budget*`, `payroll`, `nauczyciel*`, `ksiegow*`, `finans*`, `faktur*`,
    ],
    compass: [
        `plan`, `planner*`, `planning`, `roadmap*`, `strateg*`, `architect*`, `product`, `pm`, `pmo`, `navigat*`,
        `direction*`, `organiz*`, `organis*`, `schedul*`, `calendar*`, `agenda*`, `coordinat*`, `orchestrat*`,
        `dispatch*`, `router`, `routing`, `scrum*`, `agile`, `sprint*`, `backlog*`, `travel*`, `trip`, `concierge*`,
        `secretar*`, `operations`, `logistic*`, `decision*`, `advis*`, `consult*`, `requirement*`, `estimat*`,
        `guide`, `planist*`, `planow*`, `sekretar*`,
    ],
    sprout: [
        `growth`, `grow*`, `market*`, `seo`, `sales`, `sell*`, `social`, `communit*`, `outreach`, `ads`, `advert*`,
        `campaign*`, `launch*`, `garden*`, `nurtur*`, `plant*`, `farm*`, `sustainab*`, `retention`, `engagement`, `crm`,
        `leads`, `leadgen`, `partner*`, `fundrais*`, `invest*`, `revenue`, `business`, `bizdev`, `recruit*`, `hiring`,
        `hr`, `influenc*`, `audience`, `pitch*`, `health*`, `wellness`, `fitness`, `habit*`, `sprzeda*`, `ogrod*`,
        `rekrut*`,
    ],
    shield: [
        `secur*`, `safe*`, `guard*`, `protect*`, `defen*`, `keeper*`, `gatekeep*`, `sentinel*`, `sentry`, `watchdog*`,
        `watcher*`, `qa`, `test*`, `quality`, `verif*`, `validat*`, `checker*`, `audit*`, `complian*`, `legal`,
        `lawyer*`, `law`, `attorney*`, `privacy`, `gdpr`, `rodo`, `risk*`, `pentest*`, `vuln*`, `threat*`, `moderat*`,
        `trust`, `sre`, `reliab*`, `incident*`, `oncall`, `monitor*`, `alert*`, `backup*`, `recovery`, `polic*`,
        `lint*`, `approv*`, `permission*`, `auth`, `authn`, `authz`, `authentication`, `firewall*`, `spam`, `fraud*`,
        `e2e`, `authoriz*`, `bezpiecz*`, `ochron*`, `prawni*`,
    ],
} satisfies Record<AssistantAccessory, readonly string[]>;

// Titles that say someone is senior or responsible without saying at what.
const GENERIC = {
    terminal: [`engineer*`, `eng`, `cto`, `inzynier*`],
    compass: [
        `manager*`, `management`, `manage`, `lead`, `leader*`, `head`, `director*`, `chief`, `captain*`, `boss`,
        `supervisor*`, `founder*`, `ceo`, `principal`, `kierownik*`, `lider*`, `szef*`, `menedzer*`,
    ],
    palette: [],
    magnifier: [],
    scroll: [],
    book: [],
    sprout: [],
    shield: [],
} satisfies Record<AssistantAccessory, readonly string[]>;

interface Vocabulary {
    readonly exact: ReadonlyMap<string, AssistantAccessory>;
    // Longest first, so `copywrit*` answers before a shorter stem that also fits.
    readonly stems: readonly (readonly [string, AssistantAccessory])[];
}

const vocabulary = (table: Record<AssistantAccessory, readonly string[]>): Vocabulary => {
    const exact = new Map<string, AssistantAccessory>();
    const stems: [string, AssistantAccessory][] = [];
    // SAFETY: `table` is keyed by exactly the accessories (both tables are checked with `satisfies`), so every key is one.
    for (const [accessory, words] of Object.entries(table) as [AssistantAccessory, readonly string[]][]) {
        for (const word of words) {
            if (word.endsWith(`*`)) {
                stems.push([word.slice(0, -1), accessory]);
            } else {
                exact.set(word, accessory);
            }
        }
    }
    return { exact, stems: stems.sort(([a], [b]) => b.length - a.length) };
};

const specialties = vocabulary(SPECIALTIES);
const generic = vocabulary(GENERIC);

// A stem only counts when it is longer than `reaching`. Two words read as one pass the first word's length, so the
// stem has to reach into the second (`copywrit*` for copy writer); one the first word matches alone would answer for
// both and skip the second, and a Security Researcher researches.
const lookup = (word: string, words: Vocabulary, reaching = 0): AssistantAccessory | undefined =>
    words.exact.get(word) ??
    (word.length > 2 && word.endsWith(`s`) ? words.exact.get(word.slice(0, -1)) : undefined) ??
    words.stems.find(([stem]) => stem.length > reaching && word.startsWith(stem))?.[1];

/** The name as lowercase words: accents folded, camelCase and every separator split, so `UI/UX`, `uxDesigner` and `ux-designer` all read alike. */
export const nameWords = (name: string): string[] =>
    name
        .normalize(`NFKD`)
        .replace(/[\u0300-\u036f]/g, ``)
        .replace(/[łŁ]/g, (letter) => (letter === `ł` ? `l` : `L`))
        .replace(/([a-z0-9])([A-Z])/g, `$1 $2`)
        .replace(/([A-Z])([A-Z][a-z])/g, `$1 $2`)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== ``);

// The rightmost word the vocabulary knows. A word is tried joined with the one before it first, so `front end`,
// `on-call` and `copy writer` read as the one word they are.
const rightmost = (words: readonly string[], known: Vocabulary): AssistantAccessory | undefined => {
    for (let at = words.length - 1; at >= 0; at--) {
        const before = words[at - 1];
        const joined = before === undefined ? undefined : lookup(`${before}${words[at]}`, known, before.length);
        const found = joined ?? lookup(words[at]!, known);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
};

// The one `projectPersonaId` (web, features/sandbox/personas/projectPersona.ts) writes: `project-` and the project's
// path, labelled with its last segment. Renaming the label ends the match, and the new name is read like any other.
const namedAfterItsRepo = ({ id, label }: PersonaLike): boolean => {
    if (label === undefined || !id.startsWith(`project-`)) {
        return false;
    }
    const segment = label.replace(/[^a-zA-Z0-9_-]+/g, `-`).toLowerCase();
    const path = id.slice(`project-`.length).toLowerCase();
    return segment !== `` && (path === segment || path.endsWith(`-${segment}`));
};

/** The prop a persona holds, read from its name (see the rules above). */
export function personaAccessory(persona: PersonaLike): AssistantAccessory {
    if (namedAfterItsRepo(persona)) {
        return `terminal`;
    }
    const words = nameWords(persona.label ?? persona.id);
    return rightmost(words, specialties) ?? rightmost(words, generic) ?? `terminal`;
}
