import type { ViewAsk } from "@intentic/extension-api";
import type { ApprovalsList, ApprovalSummary, HookRequest, HookRequests } from "@intentic/sandbox-contract";
import { destinationOf } from "./postText";
import { waitingHooksOf } from "./useHookRequests";
import { t } from "./i18n.js";

// What this queue asks of a person, item by item, for the host's Needs you inbox (ViewRegistration.asks): a proposal
// owing a yes, a failure owing a retry, a hook set owing a yes or a no, and a record that could not be read. Only the
// decision travels there; editing, scheduling, rejecting and the history stay on this extension's page, which each ask
// opens. Pure: the presses are handed in, so the rules can be tested without a host.

// The two reads the asks are built from, as the badge poll last saw them. Absent hooks: not a maintainer's, or not read.
export interface QueueSnapshot {
    readonly list?: ApprovalsList | undefined;
    readonly hooks?: HookRequests | undefined;
}

export interface AskPresses {
    // An approval re-posted whole with its status moved (approve, retry): the same upsert the page makes.
    readonly save: (item: ApprovalSummary) => Promise<void>;
    readonly letHooksRun: (digest: string) => Promise<void>;
    readonly keepHooksOff: (digest: string) => Promise<void>;
}

// The page, opened on the slice the ask belongs to.
const pageFor = (scope: string | undefined): string => (scope === undefined ? `/ext/approvals` : `/ext/approvals?scope=${encodeURIComponent(scope)}`);

// A platform id as a person would say it; the page reads the proper name off the connector's catalog, which a module
// with nothing mounted cannot, so this is the same fallback the page uses when no connector is installed.
const platformName = (platform: string): string => `${platform.charAt(0).toUpperCase()}${platform.slice(1)}`;

// What the row leads with: a post's headline, else its opening line cut to a headline's length (the whole post is the
// ask's body right under it, so a first line kept whole only says it twice); an action's summary.
const HEADLINE_CHARS = 80;
const headline = (item: ApprovalSummary): string => {
    if (item.kind === `action`) {
        return item.summary;
    }
    const opening = item.title ?? item.content.split(`\n`)[0] ?? item.id;
    return opening.length <= HEADLINE_CHARS ? opening : `${opening.slice(0, HEADLINE_CHARS - 1).trimEnd()}…`;
};

// Where it goes and as whom, after the kind.
const contextOf = (item: ApprovalSummary): string | undefined => {
    const parts = item.kind === `post` ? [platformName(item.platform), item.target === undefined ? undefined : destinationOf(item.target).label] : [];
    const joined = [...parts, item.actsAs === undefined ? undefined : `${t(`approvalMeta.as`)} ${item.actsAs}`].filter((part) => part !== undefined).join(` · `);
    return joined === `` ? undefined : joined;
};

// What to read before saying yes: the post as it will go out, or the action's specifics under its summary.
const bodyOf = (item: ApprovalSummary): string | undefined => (item.kind === `post` ? item.content : item.details);

const proposalAsk = (item: ApprovalSummary, presses: AskPresses): ViewAsk => ({
    id: item.id,
    kind: item.kind === `post` ? t(`asks.post`) : t(`asks.action`),
    title: headline(item),
    context: contextOf(item),
    body: bodyOf(item),
    // A post goes out as the characters it is; an action's specifics are written as Markdown.
    bodyFormat: item.kind === `post` ? `text` : `markdown`,
    icon: item.kind === `post` ? `send` : `bolt`,
    createdAt: item.createdAt,
    open: pageFor(item.kind === `post` ? item.platform : `actions`),
    note: t(`asks.holdNote`),
    actions: [{ label: t(`approvalsView.approve`), icon: `check`, tone: `primary`, run: () => presses.save({ ...item, status: `approved` }) }],
});

// Tried and stopped: its reason leads, and a retry is the same yes again.
const failedAsk = (item: ApprovalSummary, presses: AskPresses): ViewAsk => ({
    ...proposalAsk(item, presses),
    tone: `danger`,
    note: item.error ?? t(`asks.failedNoReason`),
    actions: [{ label: t(`approvalsView.retry`), icon: `refresh`, tone: `primary`, run: () => presses.save({ ...item, status: `approved` }) }],
});

// One line per hook, as the page's own body lists them: when it fires, on what, and what it runs.
const hooksBody = (request: HookRequest): string =>
    request.hooks.map((hook) => [hook.event, hook.matcher, hook.run].filter((part) => part !== undefined && part !== ``).join(`  `)).join(`\n`);

const hooksAsk = (request: HookRequest, presses: AskPresses): ViewAsk => ({
    id: `hooks:${request.digest}`,
    kind: t(`approvalsView.hooks`),
    title: t(`asks.hooksTitle`, { count: request.hooks.length }, request.hooks.length),
    context: t(`approvalsView.hooksFound`),
    body: hooksBody(request),
    icon: `shield`,
    createdAt: request.seenAt,
    open: pageFor(`hooks`),
    note: t(`asks.hooksNote`),
    actions: [
        { label: t(`approvalsView.letThemRun`), icon: `check`, tone: `primary`, run: () => presses.letHooksRun(request.digest) },
        { label: t(`approvalsView.keepOff`), tone: `secondary`, run: () => presses.keepHooksOff(request.digest) },
    ],
});

export const asksOf = (snapshot: QueueSnapshot | undefined, presses: AskPresses): readonly ViewAsk[] => {
    const approvals = snapshot?.list?.approvals ?? [];
    const invalid = snapshot?.list?.invalid ?? [];
    return [
        ...approvals.filter((item) => item.status === `failed`).map((item) => failedAsk(item, presses)),
        ...approvals.filter((item) => item.status === `proposed`).map((item) => proposalAsk(item, presses)),
        // Unparsed files have no row of their own on the page either; one ask names them all.
        ...(invalid.length === 0
            ? []
            : [
                  {
                      id: `invalid`,
                      kind: t(`asks.files`),
                      title: t(`asks.unreadableTitle`, { count: invalid.length }, invalid.length),
                      body: invalid.join(`\n`),
                      icon: `exclamation-triangle`,
                      tone: `danger` as const,
                      open: pageFor(undefined),
                  },
              ]),
        ...waitingHooksOf(snapshot?.hooks).map((request) => hooksAsk(request, presses)),
        // Nothing to approve, but a person is owed the news: with the record unread, no workspace hook runs at all.
        ...(snapshot?.hooks?.ledgerUnreadable === true
            ? [
                  {
                      id: `hook-ledger`,
                      kind: t(`approvalsView.hooks`),
                      title: t(`asks.ledgerTitle`),
                      note: t(`approvalsView.hookLedgerUnreadable`),
                      icon: `shield`,
                      tone: `danger` as const,
                      open: pageFor(`hooks`),
                  },
              ]
            : []),
    ];
};
