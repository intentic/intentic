import type { AgentSummary, TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import { SUPPORT_SWEEP_PATH } from "./browserShots";
import { KEY_EXPIRE_PROGRAM, SOFT_DELETES_JOBS, SOFT_E2E_JOB, SOFT_TYPECHECK_JOB } from "./fleet";
import { PAYOUTS_PAGE } from "./pages";

// THE TRANSCRIPT SPECIMEN: one conversation holding every row, card, notice and fold the chat column can draw, in an
// order a real session could have produced, so the column's rhythm, type and colour are judged on one page against
// the real components. Opened as a tab only in a dev build (openChats.ts); the published demo never shows it.

export const SPECIMEN_CHAT_ID = `cnv_transcript_specimen`;
export const SPECIMEN_SESSION = `ses_01j9specimen`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// A parent's message to a running child, clipped where the daemon clips one for its card.
const CHILD_MESSAGE = `I reviewed your landed code while finishing accessibility. Please check concurrent platform mutations before finalising the ownership claims: addMember/removeMember read lastAdmin and then write outside a transaction, so two admins can concurrently demote/remove each other and leave zero admins; sandbox.delete checks orgId before trashSandbox, and eraseAccount checks bound ownership before its transaction, so a concurrent bind can race the guard. Please make these constraints atomic using the platform's existing transaction/row-lock conventions and add meaningful concurrent tests where…`;

const RENDERER_BEFORE = `pub fn render(rows: &[Row]) -> String {
    let mut out = String::new();
    for row in rows {
        out.push_str(&row.label);
        out.push('\\n');
    }
    out
}
`;

const RENDERER_AFTER = `pub fn render(rows: &[Row], width: usize) -> String {
    let mut out = String::new();
    for row in rows {
        // Labels wider than the terminal are cut on a char boundary, never mid-glyph.
        out.push_str(&truncate(&row.label, width));
        out.push('\\n');
    }
    out
}
`;

const READ_BODY = [
    `     1→use std::io::{self, Write};`,
    `     2→`,
    `     3→/// One line of the sandbox list, as the renderer draws it.`,
    `     4→pub struct Row {`,
    `     5→    pub label: String,`,
    `     6→    pub state: State,`,
    `     7→}`,
    `     8→`,
    `     9→pub fn render(rows: &[Row]) -> String {`,
    `    10→    let mut out = String::new();`,
].join(`\n`);

const CHECKLIST = [
    `Hunt bugs in the one-liner Worker routes and verb table`,
    `Hunt bugs in the POSIX install scripts and sh kit`,
    `Hunt bugs in the PowerShell install scripts and ps1 kit`,
    `Hunt bugs in ic (Rust): renderer and sandbox lifecycle`,
    `Verify findings, fix the clear ones, report`,
];

const todos = (done: number, running: number): TranscriptRow[`todos`] =>
    CHECKLIST.map((content, index) =>
        index === running
            ? { content, status: `in_progress` as const, activeForm: content.replace(/^Hunt bugs in/, `Hunting in`) }
            : { content, status: index < done ? (`completed` as const) : (`pending` as const) },
    );

const read: TranscriptTool = {
    id: `tc_spec_read`,
    name: `Read`,
    category: `read`,
    status: `completed`,
    target: `ic/src/render.rs`,
    locations: [{ path: `ic/src/render.rs`, line: 1 }],
    content: [{ type: `text`, text: READ_BODY }],
};

const grep: TranscriptTool = {
    id: `tc_spec_grep`,
    name: `Grep`,
    category: `search`,
    status: `completed`,
    target: `fn render`,
    content: [{ type: `text`, text: `ic/src/render.rs:9\nic/src/list.rs:42\nic/src/doctor.rs:118` }],
};

const edit: TranscriptTool = {
    id: `tc_spec_edit`,
    name: `Edit`,
    category: `edit`,
    status: `completed`,
    target: `ic/src/render.rs`,
    locations: [{ path: `ic/src/render.rs`, line: 9 }],
    content: [{ type: `diff`, path: `ic/src/render.rs`, oldText: RENDERER_BEFORE, newText: RENDERER_AFTER }],
};

const bash: TranscriptTool = {
    id: `tc_spec_bash`,
    name: `Bash`,
    category: `execute`,
    status: `completed`,
    target: `cargo test -p ic render`,
    content: [
        {
            type: `text`,
            text: `running 6 tests\ntest render::tests::fits_width ... ok\ntest render::tests::cuts_on_char_boundary ... ok\ntest render::tests::empty_list ... ok\n\ntest result: ok. 6 passed; 0 failed; finished in 0.04s`,
        },
    ],
};

const failedBash: TranscriptTool = {
    id: `tc_spec_bash_failed`,
    name: `Bash`,
    category: `execute`,
    status: `failed`,
    target: `sh scripts/install.sh --dry-run`,
    content: [{ type: `text`, text: `scripts/install.sh: line 88: syntax error near unexpected token \`fi'\nexit status 2` }],
};

const repeatedReads: TranscriptTool[] = [1, 2, 3].map((n) => ({
    id: `tc_spec_ps_${n}`,
    name: `Read`,
    category: `read`,
    status: `completed`,
    target: `scripts/install.ps1`,
    locations: [{ path: `scripts/install.ps1`, line: n * 40 }],
}));

const subagent: TranscriptTool = {
    id: `tc_spec_agent`,
    name: `Agent`,
    category: `other`,
    status: `completed`,
    subagent: {
        kind: `subagent`,
        agentType: `Explore`,
        description: `Find every place the install scripts parse flags`,
        status: `completed`,
        toolUses: 14,
        tokens: 38_200,
        summary: `Flags are parsed in three places: install.sh (getopts), install.ps1 (param block) and the Worker's verb table. Only install.sh accepts --dry-run.`,
    },
    children: [
        { id: `tc_spec_agent_1`, name: `Grep`, category: `search`, status: `completed`, target: `--dry-run` },
        { id: `tc_spec_agent_2`, name: `Read`, category: `read`, status: `completed`, target: `scripts/install.sh` },
    ],
};

const screenshot: TranscriptTool = {
    id: `tc_spec_shot`,
    name: `Browser take screenshot`,
    category: `other`,
    status: `completed`,
    target: `Install page after the fix`,
    content: [{ type: `image`, path: SUPPORT_SWEEP_PATH }],
};

const docx: TranscriptTool = {
    id: `tc_spec_docx`,
    name: `Bash`,
    category: `execute`,
    status: `completed`,
    target: `pandoc report.md -o report.docx`,
    locations: [{ path: `report.docx` }],
    content: [{ type: `text`, text: `` }],
};

const ANSWER_MARKDOWN = [
    `Found **three real bugs** and one false alarm. The renderer one is fixed; the other two need a decision.`,
    ``,
    `### What broke`,
    ``,
    `1. \`ic list\` cut labels mid-glyph on narrow terminals — fixed in [ic/src/render.rs:9](ic/src/render.rs#L9).`,
    `2. \`install.sh --dry-run\` fails on line 88: an \`fi\` without its \`if\`.`,
    `3. The PowerShell kit ignores \`-Force\` when the target exists.`,
    ``,
    `| Area | Found | Fixed |`,
    `| --- | --- | --- |`,
    `| ic renderer | 1 | 1 |`,
    `| sh kit | 1 | 0 |`,
    `| ps1 kit | 1 | 0 |`,
    ``,
    `> The Worker's verb table looked wrong at first, but \`HEAD\` falls through to \`GET\` on purpose.`,
    ``,
    `\`\`\`sh`,
    `sh scripts/install.sh --dry-run   # still fails until the fi is fixed`,
    `\`\`\``,
].join(`\n`);

const NOTES = [
    {
        title: `Project map`,
        text: `intentic/_sandbox: one private box per project\nintentic/_editor: the editor\nintentic/_tools: the foundation`,
    },
    { title: `Checks after landing`, text: `Run the checks that cover what you changed while you work.` },
];

const messages: TranscriptRow[] = [
    {
        role: `user`,
        sentAt: Date.now() - DAY - 2 * HOUR,
        text: `As a follow-up to mellow-wren-woh7 run a bug-hunting exploratory session that will aim to find bugs in CLI tools and scripts.`,
        notes: NOTES,
        attachments: [SUPPORT_SWEEP_PATH, `notes/bughunt-scope.md`],
        rewindIndex: 0,
        checkpointId: `chk_spec_0`,
    },
    {
        role: `assistant`,
        text: `Starting with the renderer, since \`ic list\` is what every install ends on.`,
        thinking: `The renderer and the install kits share nothing, so they can be hunted independently. Read the renderer first: it is the smallest surface and the one every user sees.`,
        tools: [read, grep],
        todos: todos(0, 0),
    },
    {
        role: `assistant`,
        text: `The label is pushed whole, whatever the terminal width. Cutting it on a char boundary and covering it with a test.`,
        tools: [edit, bash],
    },
    {
        role: `notice`,
        text: `Background job: ${SOFT_DELETES_JOBS(Date.now()).find((job) => job.id === SOFT_TYPECHECK_JOB)!.label}`,
        backgroundJob: (() => {
            const job = SOFT_DELETES_JOBS(Date.now()).find((entry) => entry.id === SOFT_TYPECHECK_JOB)!;
            return { id: job.id, label: job.label, command: job.command, startedAt: job.startedAt };
        })(),
    },
    {
        role: `notice`,
        text: `Background job: ${SOFT_DELETES_JOBS(Date.now()).find((job) => job.id === SOFT_E2E_JOB)!.label}`,
        backgroundJob: (() => {
            const job = SOFT_DELETES_JOBS(Date.now()).find((entry) => entry.id === SOFT_E2E_JOB)!;
            return { id: job.id, label: job.label, command: job.command, startedAt: job.startedAt };
        })(),
    },
    {
        role: `assistant`,
        text: `Renderer fixed. Handing the flag parsing to a helper while I try the sh kit myself.`,
        tools: [subagent, ...repeatedReads, failedBash],
        todos: todos(1, 1),
    },
    { role: `notice`, text: `Claude usage limit reached. Send again once it resets.` },
    { role: `notice`, text: `Switched to Claude: your next message starts a fresh session with the conversation so far carried over.` },
    { role: `notice`, text: `Sent again on the switched account after the allowance ran out mid-turn, carrying the session with it.` },
    { role: `notice`, text: `Continued in the same session, re-reading all of it.` },
    { role: `notice`, text: `Context is 81% full; older tool output will be trimmed first.`, agentNotice: { level: `warning`, source: `context-guard` } },
    { role: `notice`, text: `The hook "pre-commit" exited 1: lint found 2 problems.`, agentNotice: { level: `error` } },
    {
        role: `assistant`,
        text: `Restarting after the interruption: my two fixes so far are safe (checkpointed), and the hunting agents stopped mid-run. Resuming each from where it left off.`,
    },
    {
        role: `assistant`,
        text: ``,
        permission: {
            requestId: `perm_spec_run`,
            toolName: `Bash`,
            title: `Run this on rog?`,
            displayName: `Run command`,
            explain: `The safety judge is turned off, so this was decided by the standing rule alone.`,
            program: {
                text: `$d = Join-Path $env:TEMP 'bughunt-ps'; Remove-Item -Recurse -Force $d; "removed: $(-not (Test-Path $d))"; Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*bughunt*' } | Measure-Object`,
                language: `bash`,
                truncated: false,
                spans: [{ start: 42, end: 70 }],
            },
            status: `allowed`,
        },
    },
    {
        role: `assistant`,
        text: `Two of the five areas are done. The PowerShell kit is next.`,
        todos: todos(2, 2),
    },
    {
        role: `user`,
        sentAt: Date.now() - 3 * HOUR,
        text: `Good. Write it up as a plan before you touch the PowerShell kit, and show me the report as a page.`,
        rewindIndex: 9,
        checkpointId: `chk_spec_9`,
    },
    {
        role: `assistant`,
        text: ``,
        plan: {
            requestId: `plan_spec`,
            text: `1. Reproduce the \`-Force\` bug against an existing target.\n2. Fix the param block so \`-Force\` reaches \`Remove-Item\`.\n3. Add a Pester test for both paths.\n4. Re-run the whole ps1 kit.`,
            status: `approved`,
        },
    },
    {
        role: `assistant`,
        text: ``,
        question: {
            requestId: `q_spec_answered`,
            questions: [
                {
                    question: `Should the sh fix land with this branch or on its own?`,
                    header: `Landing`,
                    multiSelect: false,
                    options: [
                        { label: `With this branch`, description: `One review, one land.` },
                        { label: `On its own`, description: `A separate branch, so it can ship today.` },
                    ],
                },
            ],
            answers: { [`Should the sh fix land with this branch or on its own?`]: [`On its own`] },
            status: `answered`,
        },
    },
    {
        role: `assistant`,
        text: `The report, as a page. The numbers are the ones the hunt recorded.`,
        tools: [{ id: `tc_spec_page`, name: `Show page`, category: `other`, status: `completed` }, screenshot, docx],
        page: { ...PAYOUTS_PAGE },
    },
    {
        role: `assistant`,
        text: ``,
        browserHelp: {
            requestId: `bh_spec`,
            session: `web`,
            account: `github`,
            message: `Sign in to GitHub so I can read the Actions logs for the failing install job.`,
            status: `helped`,
        },
    },
    {
        role: `assistant`,
        text: ``,
        terminalHelp: {
            requestId: `th_spec`,
            session: `term-1`,
            message: `Type the one-time code your authenticator shows for npm.`,
            status: `declined`,
        },
    },
    {
        role: `assistant`,
        text: ``,
        capabilityOffer: {
            requestId: `cap_spec`,
            offer: { entry: `github`, name: `GitHub`, why: `To open an issue for each bug the hunt found.` },
            status: `pending`,
        },
    },
    {
        role: `assistant`,
        text: ``,
        paymentOffer: {
            requestId: `pay_spec`,
            offer: {
                url: `https://api.example.dev/v1/lint`,
                description: `Hosted shellcheck, per call`,
                payTo: `0x8f3c…a21d`,
                network: `base`,
                asset: `0x8335…2913`,
                assetName: `USDC`,
                amountUsd: `0.02`,
                spentTodayUsd: `0.14`,
                dailyCapUsd: `5.00`,
                why: `To lint the sh kit with the same shellcheck CI runs.`,
            },
            status: `approved`,
            receipt: { outcome: `paid`, amountUsd: `0.02`, transaction: `0x4be1…90cf`, network: `base` },
        },
    },
    {
        role: `assistant`,
        text: ``,
        credentialOffer: {
            requestId: `cred_spec`,
            offer: {
                subject: `stripe/secret-key`,
                kind: `secret`,
                lane: `shell`,
                detail: KEY_EXPIRE_PROGRAM.text.slice(0, 48),
                why: `To check the install script's Stripe step end to end.`,
                approvers: [`Ada`],
                scope: `use`,
            },
            status: `approved`,
            receipt: { outcome: `released`, approvedBy: `Ada` },
        },
    },
    {
        role: `assistant`,
        text: ``,
        permission: {
            requestId: `perm_spec_child_send`,
            toolName: `agents.spawn`,
            title: `Send this to a subagent on Claude Code?`,
            displayName: `Send it`,
            reason: `this turn has taken in content from outside (web), and a subagent would spend the owner's accounts on its say-so`,
            alwaysLabel: `Allow for the rest of this turn`,
            child: {
                move: `send`,
                child: `sub-brisk-otter-4k2m`,
                task: `Harden institutional governance and ownership in Intentic`,
                message: CHILD_MESSAGE,
                provider: `claude`,
                model: `claude-opus-5-5`,
                effort: `xhigh`,
                on: `here`,
            },
            status: `allowed`,
        },
    },
    {
        role: `notice`,
        text: `The STRIPE_SECRET_KEY secret`,
        need: {
            id: `need-spec-secret`,
            conversationId: SPECIMEN_CHAT_ID,
            subject: { kind: `secret`, name: `NPM_TOKEN`, where: `the publish step of scripts/release.sh`, hint: `starts with npm_` },
            title: `The NPM_TOKEN secret`,
            why: `to dry-run the publish step the install script ends with`,
            status: `open`,
            createdAt: Date.now() - HOUR,
            updatedAt: Date.now() - HOUR,
        },
    },
    {
        role: `assistant`,
        text: `Written in your voice, so the record says why the ps1 fix waited.`,
        placed: true,
    },
    {
        role: `user`,
        errand: `ci-fix`,
        text: `The CI pipeline for the workspace repo "intentic" failed on branch main. Investigate and fix it.\n\nFailed jobs: install-scripts.`,
    },
    {
        role: `notice`,
        text: `The watch on "CI run 316" fired after 43m: the run finished.`,
        watchWake: { outcome: `met`, note: `CI run 316 on intentic/intentic`, elapsed: `43m`, sent: `The watch you armed fired: CI run 316 finished with status success.` },
    },
    {
        role: `notice`,
        text: `brisk-otter reported back: 4 tests written, all passing.`,
        agentWords: { kind: `child`, from: `sub-brisk-otter-4k2m`, title: `Webhook tests`, sent: `Report from brisk-otter: 4 tests written, all passing.` },
    },
    {
        role: `assistant`,
        text: ANSWER_MARKDOWN,
        todos: todos(4, -1),
    },
    { role: `notice`, text: `Finished: the work is on this agent's branch, ready to land from its review.` },
    { role: `user`, text: `Continue`, sentAt: Date.now() - 20 * 60_000 },
    {
        role: `assistant`,
        text: ``,
        permission: {
            requestId: `perm_spec_child_spawn`,
            toolName: `agents.spawn`,
            title: `Start a subagent on Claude Code?`,
            displayName: `Start it`,
            reason: `this turn has taken in content from outside (web), and a subagent would spend the owner's accounts on its say-so`,
            alwaysLabel: `Allow for the rest of this turn`,
            child: {
                move: `spawn`,
                task: `Fix the ps1 kit's -Force handling`,
                message: `Reproduce the -Force bug in scripts/install.ps1 against an existing target directory, then fix the param block so -Force reaches Remove-Item.\n\nAdd a Pester test covering both paths (target exists, target missing) and re-run the whole ps1 kit on Windows PowerShell 5.1 and pwsh 7. Do not touch the sh kit: another agent owns it. Report what you changed, the test output, and anything in the kit that looked wrong but was out of scope.`,
                provider: `claude`,
                model: `claude-opus-5-5`,
                effort: `xhigh`,
                on: `here`,
            },
            status: `pending`,
        },
    },
    {
        role: `assistant`,
        text: ``,
        question: {
            requestId: `q_spec_live`,
            questions: [
                {
                    question: `Which fix should go first?`,
                    header: `Order`,
                    multiSelect: false,
                    options: [
                        { label: `sh kit (Recommended)`, description: `Breaks every dry run today.`, preview: `scripts/install.sh:88\n-   fi\n+   fi  # closes the if on line 71` },
                        { label: `ps1 kit`, description: `Only bites when the target already exists.` },
                    ],
                },
            ],
            status: `pending`,
        },
    },
];

export const SPECIMEN_TRANSCRIPT = {
    sessionId: SPECIMEN_SESSION,
    provider: `claude` as const,
    harness: `claude-code` as const,
    account: `acc_claude_demo`,
    messages,
};

// The board's card for it: a finished run with its two background jobs, so the job rows have live state to read.
export const specimenCard = (now: number): AgentSummary => ({
    id: SPECIMEN_CHAT_ID,
    startIn: `intentic`,
    sessionId: SPECIMEN_SESSION,
    title: `Transcript specimen: every row the chat draws`,
    status: `ready`,
    provider: `claude`,
    harness: `claude-code`,
    model: `claude-opus-5-5`,
    account: `acc_claude_demo`,
    branch: `agent/transcript-specimen`,
    base: `4f1c8ab`,
    autoLand: false,
    costUsd: 2.41,
    inputTokens: 212_000,
    outputTokens: 18_400,
    updatedAt: now - 60_000,
    seenAt: now - 60_000,
    attention: { plan: false, question: true, permission: false, capability: false, credential: false, conflict: false },
    turns: 4,
    toolUses: 31,
    jobs: SOFT_DELETES_JOBS(now).map(({ command: _command, ...job }) => job),
});
