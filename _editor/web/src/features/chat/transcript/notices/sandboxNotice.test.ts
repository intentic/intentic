import {
    type AgentEvent,
    childReportPrompt,
    needWakePrompt,
    noticeCode,
    peerMessagePrompt,
    RESUME_NOTES,
    type ResumeReason,
    resumeDisclosure,
    resumeNoticeRow,
    type TranscriptRow,
    unspokenPromptRow,
    watchWakePrompt,
    withResumeNote,
} from "@intentic/sandbox-contract";
import { foldTurn, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { setLocale } from "@intentic/ui/i18n";
import { noticeLine, refusalWords } from "./sandboxNotice";

// The sandbox writes its notices in English with a code beside them; the chat says them in the reader's language and
// words. The rows here come from the sandbox's own fold and prompt readers, never typed by hand, so a sentence the
// sandbox rewords fails the English case below instead of drifting apart from its translation.

const GIB = 1024 ** 3;
// The coded notices a turn folds to; a provider's own uncoded words have nothing to translate.
const turn = (events: readonly AgentEvent[], ending: `settled` | `stopped` = `settled`): TranscriptRow[] =>
    foldTurn([userRow(`go`, 0, [])], events, ending).filter((row) => row.role === `notice` && row.noticeCode !== undefined);
const conflicts = [
    { repo: `root`, paths: [{ path: `a.ts`, reason: `diverged` as const }], clean: 0 },
    { repo: `web`, paths: [{ path: `b.ts`, reason: `diverged` as const }, { path: `c.ts`, reason: `diverged` as const }], clean: 0 },
];
const refused: AgentEvent = { kind: `error`, code: `claude-token-refused`, message: `Token refused.`, autoResume: `scheduled` };

// Every notice the fold codes, as a live turn and a stored one both draw it.
const FOLDED: readonly TranscriptRow[] = [
    ...turn([{ kind: `worktree`, branch: `agent/x`, base: `abc1234`, sync: { commits: 1, blocked: [] } }]),
    ...turn([{ kind: `worktree`, branch: `agent/x`, base: `abc1234`, sync: { commits: 3, blocked: [`web`, `api`] } }]),
    ...turn([{ kind: `compact`, trigger: `auto` }], `stopped`),
    ...turn([{ kind: `landed`, landed: true }]),
    ...turn([{ kind: `landed`, landed: true, deps: { missing: 1, started: [`deps-1`], deferred: false } }]),
    ...turn([{ kind: `landed`, landed: true, deps: { missing: 3, started: [], deferred: true } }]),
    ...turn([{ kind: `landed`, landed: true, held: true }]),
    ...turn([{ kind: `landed`, landed: false, conflicts }]),
    ...turn([{ kind: `landed`, landed: true, into: `p1` }]),
    ...turn([{ kind: `landed`, landed: false, into: `p1`, conflicts }]),
    ...turn([{ kind: `error`, code: `provider-outage`, message: `Anthropic is down.`, autoResume: `scheduled`, retries: { made: 1, max: 6 } }]),
    ...turn([{ kind: `error`, message: `Timed out.`, autoResume: `available`, retries: { made: 3, max: 3 } }]),
    ...turn([{ kind: `error`, code: `provider-outage`, message: `Anthropic is down.`, autoResume: `available` }]),
    ...turn([refused]),
    ...turn([refused, { kind: `error`, message: `401.` }]),
    ...turn([{ kind: `error`, code: `claude-token-refused`, message: `Token refused.` }]),
    ...turn([{ kind: `error`, code: `context-window-too-small`, message: `This model accepts 16,384 tokens.` }]),
    ...turn([{ kind: `error`, code: `context-window-too-small`, message: `This model accepts 16,384 tokens.`, unattended: true }]),
    ...turn([{ kind: `error`, code: `context-window-too-small`, message: `This model accepts 16,384 tokens.`, held: { ran: false } }]),
    ...turn([{ kind: `error`, code: `agent-busy`, message: `This agent is already running a turn, wait for it to finish.` }]),
    ...turn([{ kind: `prompt_cache`, readTokens: 305_000, writtenTokens: 2_000, kept: { forMs: 125 * 60_000, refreshes: 1 } }]),
    ...turn([{ kind: `prompt_cache`, readTokens: 0, writtenTokens: 310_000, kept: { forMs: 7 * 60_000, refreshes: 3 } }]),
    ...turn([{ kind: `context_trim`, window: 16_384, omitted: [`Field notes`, `Skills`], base: true }]),
    ...turn([{ kind: `context_trim`, window: 32_768, omitted: [], base: false }]),
];

// What the daemon writes outside the fold, each as it writes it.
const DAEMON: readonly TranscriptRow[] = [
    { role: `notice`, text: `Question dismissed.`, noticeCode: noticeCode({ code: `questionDismissed` }) },
    { role: `notice`, text: `Plan approved.`, noticeCode: noticeCode({ code: `planApproved` }) },
    { role: `notice`, text: `Kept planning.`, noticeCode: noticeCode({ code: `keptPlanning` }) },
    {
        role: `notice`,
        text: `Watching for the deploy to go green, checked every 5m.`,
        noticeCode: noticeCode({ code: `watching`, params: { note: `the deploy to go green`, every: `5m` } }),
    },
    {
        role: `notice`,
        text: `The sandbox restarted before this turn finished. Send another message to continue from the saved worktree.`,
        noticeCode: noticeCode({ code: `restartInterrupted` }),
    },
];

// A re-run's row for every reason that has one, read off the prompt the re-run was sent with.
// SAFETY: RESUME_NOTES is a literal keyed by exactly the ResumeReason names (ResumeReason is its keyof).
const RESUMED: readonly TranscriptRow[] = (Object.keys(RESUME_NOTES) as ResumeReason[]).flatMap((reason) => {
    const disclosure = resumeDisclosure(withResumeNote(`ship it`, RESUME_NOTES[reason]));
    return disclosure?.kind === `notice` ? [resumeNoticeRow(disclosure)] : [];
});

// Rows whose facts are fields of their own: a watch, an answered need, another agent's words.
const UNSPOKEN: readonly TranscriptRow[] = [
    watchWakePrompt({ outcome: `met`, id: `w1`, note: `CI run 316`, elapsed: `43m`, command: `gh run view`, exitCode: 0, output: `ok` }),
    watchWakePrompt({ outcome: `timeout`, id: `w2`, note: `CI run 316`, elapsed: `2h`, command: `gh run view`, exitCode: 1, output: `` }),
    watchWakePrompt({ outcome: `broken`, id: `w3`, note: `CI run 316`, elapsed: `5m`, command: `gh run view`, exitCode: 127, output: `` }),
    watchWakePrompt({ outcome: `restart-expired`, id: `w4`, note: `CI run 316`, elapsed: `1h`, command: `gh run view`, exitCode: undefined, output: `` }),
    needWakePrompt({ outcome: `met`, id: `n1`, title: `Connect GitHub`, why: undefined, result: `Connected.`, use: [] }),
    needWakePrompt({ outcome: `declined`, id: `n2`, title: `Connect GitHub`, why: undefined, result: `Declined.`, use: [] }),
    peerMessagePrompt({ from: `sharp-shale-htw8`, title: `Bun migration`, message: `done` }),
    peerMessagePrompt({ from: `sharp-shale-htw8`, title: undefined, message: `done` }),
    childReportPrompt({ child: `sub-x7`, title: `Port the parser`, failed: false, report: `ported`, verification: undefined }),
    childReportPrompt({ child: `sub-x7`, title: undefined, failed: true, report: `broke`, verification: undefined }),
].flatMap((prompt) => unspokenPromptRow(prompt) ?? []);

describe(`a sandbox notice, as the chat says it`, () => {
    afterAll(async () => {
        await setLocale(`en`);
    });

    // The one promise English makes: the code changes nothing a developer reads.
    it(`says in English, for a developer, exactly what the sandbox's own words say`, () => {
        const rows = [...FOLDED, ...DAEMON, ...RESUMED, ...UNSPOKEN];
        expect(rows.map((row) => noticeLine(row, `developer`))).toEqual(rows.map((row) => row.text));
        // Nothing slipped through uncoded: every row above is worded by the chat, none falls back to its text.
        expect(RESUMED).toHaveLength(10);
        expect(rows.filter((row) => row.noticeCode === undefined && row.watchWake === undefined && row.needWake === undefined && row.agentWords === undefined)).toEqual([]);
    });

    it(`says the land outcomes in a maker's words: accept and draft, never land and branch`, () => {
        const landing = FOLDED.filter((row) => row.noticeCode?.code === `landed` || row.noticeCode?.code === `landHeld` || row.noticeCode?.code === `landConflict`);
        expect(landing.map((row) => noticeLine(row, `maker`))).toEqual([
            `The changes were accepted into your files: see them in What changed.`,
            `The changes were accepted into your files: see them in What changed. Installing 1 dependency it added or changed; the project's checks run when that finishes, and the outcome lands in Activity.`,
            `The changes were accepted into your files: see them in What changed. 3 dependencies it added or changed are being installed in your tree: the install waits for any other install to finish, appears in Work terminals, and its outcome lands in Activity.`,
            `Finished: the work is in this assistant's draft, ready to accept once you've looked at it.`,
            `3 files couldn't be accepted automatically in root, web. Open the assistant's changes to see what blocked them and accept from there.`,
        ]);
    });

    it(`says the sandbox's notices in Polish, with Polish plurals and the provider's own words kept as said`, async () => {
        await setLocale(`pl`);
        const line = (row: TranscriptRow | undefined): string | undefined => (row === undefined ? undefined : noticeLine(row, `developer`));
        const coded = (code: string): TranscriptRow | undefined => FOLDED.find((row) => row.noticeCode?.code === code);

        expect(line(coded(`landHeld`))).toBe(`Gotowe: praca jest na gałęzi tego agenta, gotowa do scalenia z jego przeglądu.`);
        expect(line(coded(`landConflict`))).toBe(
            `Nie udało się automatycznie scalić 3 plików w root, web. Otwórz przegląd agenta, żeby zobaczyć, co je zablokowało, i scal stamtąd.`,
        );
        expect(line(FOLDED.find((row) => row.noticeCode?.code === `synced` && row.noticeCode.params?.[`blocked`] !== undefined))).toBe(
            `Twoja przestrzeń robocza poszła naprzód, gdy ten agent czekał; jego gałąź przeniesiono na Twoje ostatnie 3 commity. Nie udało się przenieść gałęzi na Twoją przestrzeń roboczą w web, api: tura działa na starszej bazie, więc jej scalenie może wymagać rozwiązania konfliktów.`,
        );
        expect(line(coded(`retrying`))).toBe(`Anthropic is down. Ponawia sam: próba 2 z 6.`);
        expect(line(coded(`renewalWithdrawn`))).toBe(
            `Token refused. Dane logowania były odnawiane, ale tura zatrzymała się, zanim mogła ruszyć dalej: sama się nie wznowi, więc naciśnij Kontynuuj, żeby ją podjąć.`,
        );
        expect(line(coded(`undelivered`))).toBe(
            `This model accepts 16,384 tokens. Twoja wiadomość nie została dostarczona: czeka, aż wyślesz ją ponownie.`,
        );
        // A failure the sandbox worded itself is said in Polish whole.
        expect(line(coded(`failed`))).toBe(`Ten agent już wykonuje turę, poczekaj, aż skończy.`);
        expect(DAEMON.map(line).slice(0, 3)).toEqual([`Pytanie odrzucone.`, `Plan zatwierdzony.`, `Planowanie trwa dalej.`]);
        expect(line(RESUMED.find((row) => row.noticeCode?.params?.[`reason`] === `restart`))).toBe(`Sandbox znów działa, ta tura wróciła tam, gdzie przerwała.`);
        expect(UNSPOKEN.slice(0, 1).map(line)).toEqual([`CI run 316 — obserwacja zadziałała po 43m.`]);
        expect(line(UNSPOKEN.at(-2))).toBe(`Podagent „Port the parser” (sub-x7) skończył.`);
        expect(noticeLine(coded(`landed`)!, `maker`)).toBe(`Zmiany zostały przyjęte do Twoich plików: zobacz je w „Co się zmieniło”.`);
        // A turn already running, as an older sandbox refused a message and as this one refuses a re-run.
        expect(refusalWords(`a turn is already running for this conversation`)).toBe(`W tej rozmowie trwa już tura.`);
        expect(refusalWords(`a turn is already running in that conversation`)).toBe(`W tej rozmowie trwa już tura.`);
        expect(refusalWords(`The free allowance is spent.`)).toBe(`The free allowance is spent.`);
        // A kept-warm pick-up and a thin send, with the figures as the sandbox wrote them and Polish's three plurals.
        expect(line(coded(`keptWarm`))).toBe(`Wznowiono na ciepło: 305k tokenów odczytanych z pamięci podręcznej, podtrzymywanej przez 2h 5m (1 odświeżenie).`);
        expect(line(coded(`keptCold`))).toBe(
            `Wznowiono na zimno, choć pamięć podręczną podtrzymywano przez 7m (3 odświeżenia): 310k tokenów wysłano ponownie, bo prompt tej tury nie pasował już do pamięci podręcznej.`,
        );
        expect(line(coded(`contextTrim`))).toBe(
            `Wysłano w wersji odchudzonej, bo okno tego modelu ma 16k. Pominięto: Field notes, Skills. Podstawowe instrukcje samego agenta też zastąpiono krótkim akapitem. Reguły Twojej przestrzeni roboczej, persona tej tury i miejsce jej plików i tak zostały wysłane.`,
        );
        await setLocale(`en`);
    });

    // An unattended memory hold is the one coded failure drawn on the generic line: its figures stay, its words translate.
    it(`says an unattended memory hold with the sandbox's figures, in the reader's words`, async () => {
        const [held] = turn([
            {
                kind: `error`,
                code: `sandbox-memory-low`,
                message: `Sandbox memory is low: 15.9 GiB of 16.0 GiB used.`,
                memory: { limitBytes: 16 * GIB, residentBytes: 15.9 * GIB, swapBytes: 0 },
                unattended: true,
            },
        ]);
        expect(noticeLine(held!, `developer`)).toBe(
            `Sandbox memory is low (15.9/16.0 GiB). Nothing ran, and nothing is held: this run started on its own, so there is no message waiting to be sent again.`,
        );
        await setLocale(`pl`);
        expect(noticeLine(held!, `developer`)).toBe(
            `Pamięć sandboxa się kończy (15,9/16,0 GiB). Nic się nie uruchomiło i nic nie czeka: ten przebieg ruszył sam, więc nie ma wiadomości do ponownego wysłania.`,
        );
        await setLocale(`en`);
    });

    // A sandbox older than this app sends no code, and a newer one may send one this build has never heard of.
    it(`leaves a row with no code, or a code it does not know, to its own words`, () => {
        expect(noticeLine({ noticeCode: undefined }, `developer`)).toBeUndefined();
        expect(noticeLine({ noticeCode: { code: `somethingNew` } }, `developer`)).toBeUndefined();
        expect(noticeLine({ noticeCode: { code: `landConflict`, params: { files: `three`, repos: `root` } } }, `developer`)).toBeUndefined();
    });
});
