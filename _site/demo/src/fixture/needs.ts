import type { GrantRevoke, Need, NeedAnswer, StandingGrants } from "@intentic/sandbox-contract";
import { demoQuiet } from "../mode";
import { AWAITING_AGENT_ID, FEATURED_AGENT_ID } from "./fleet";

// What the demo's agents are waiting on people for (docs/architecture/needs.md): one of each kind a visitor is likely
// to meet, on conversations the board already shows, so the chat's cards, the strip above the composer, the board's
// "Needs you" chip and the inbox all have something real to draw. Answers move this store, as the daemon's would.

const minutes = (count: number): number => count * 60_000;

const seed = (now: number): Need[] => [
    {
        id: `need-7k2qa`,
        conversationId: FEATURED_AGENT_ID,
        subject: {
            kind: `secret`,
            name: `STRIPE_SECRET_KEY`,
            where: `the server-side Stripe client in web/api/checkout.ts`,
            link: `https://dashboard.stripe.com/test/apikeys`,
            hint: `starts with sk_test_`,
        },
        title: `The STRIPE_SECRET_KEY secret`,
        why: `to create the Checkout session from the API route and test it against Stripe's test mode`,
        status: `open`,
        createdAt: now - minutes(6),
        updatedAt: now - minutes(6),
    },
    {
        id: `need-3m9xd`,
        conversationId: AWAITING_AGENT_ID,
        subject: {
            kind: `capability`,
            entry: `ssh`,
            name: `SSH`,
            mode: `connect`,
            target: `staging.acme.dev`,
            prefill: { host: `staging.acme.dev`, user: `deploy` },
        },
        title: `Connect SSH for staging.acme.dev`,
        why: `to read the signup service's logs on staging, where the flaky test fails`,
        status: `open`,
        createdAt: now - minutes(21),
        updatedAt: now - minutes(21),
    },
    {
        id: `need-8p4ve`,
        conversationId: FEATURED_AGENT_ID,
        subject: {
            kind: `environment`,
            tool: `ffmpeg`,
            steps: `RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\\n    apt-get update && apt-get install -y --no-install-recommends ffmpeg`,
        },
        title: `Add ffmpeg to the sandbox image`,
        why: `to cut the checkout demo video for the pull request`,
        status: `open`,
        createdAt: now - minutes(3),
        updatedAt: now - minutes(3),
    },
    {
        id: `need-5w1rt`,
        conversationId: AWAITING_AGENT_ID,
        subject: {
            kind: `automation`,
            automation: {
                id: `playwright-1-60`,
                enabled: true,
                trigger: { kind: `schedule`, cron: `41 */6 * * *` },
                source: { kind: `npm`, package: `@playwright/test`, range: `>=1.60.0` },
                until: `first-fire`,
                expiresAt: now + minutes(60 * 24 * 45),
                target: { kind: `conversation`, conversationId: AWAITING_AGENT_ID },
                note: `Playwright 1.60 is published, with the retry fix`,
                prompt: `Playwright 1.60 is out with the fix for retried fixtures. Bump it, drop the workaround in signup.spec.ts, and run the signup suite twenty times to see whether the flake is gone.`,
            },
            firstCheck: { pass: false, saw: `no published version of @playwright/test satisfies >=1.60.0 yet (latest is 1.59.2)`, at: now - minutes(2) },
        },
        title: `Run an automation unattended: Playwright 1.60 is published, with the retry fix`,
        why: `the flake's real fix ships in Playwright 1.60; until then the workaround stays`,
        status: `open`,
        createdAt: now - minutes(2),
        updatedAt: now - minutes(2),
    },
];

let needs: Need[] | undefined;

// A quiet recording (mode.ts `demoQuiet`) starts with nothing asked: the agents have what they need.
export const demoNeeds = (now: number = Date.now()): readonly Need[] => {
    needs ??= demoQuiet() ? [] : seed(now);
    return [...needs].sort((left, right) => right.createdAt - left.createdAt);
};

const settle = (id: string, change: (need: Need) => Need): Need => {
    const current = demoNeeds().find((need) => need.id === id);
    if (current === undefined) {
        throw new Error(`No need is named "${id}".`);
    }
    const next = { ...change(current), updatedAt: Date.now() };
    needs = (needs ?? []).map((need) => (need.id === id ? next : need));
    return next;
};

// A person's answer, as the daemon would take it: a decline closes it, a yes that finishes something meets it, and an
// environment approval waits for a rebuild the demo never runs.
export const answerDemoNeed = (id: string, answer: NeedAnswer): Need =>
    settle(id, (need) => {
        switch (answer.kind) {
            case `decline`:
                return { ...need, status: `declined`, outcome: answer.note === undefined ? `` : `They said: ${answer.note}`, answeredBy: `demo@intentic.dev` };
            case `accept`:
                return { ...need, status: `working` };
            case `approve`:
                // An automation is saved by the yes itself; an environment waits for its rebuild.
                return need.subject.kind === `automation`
                    ? { ...need, status: `met`, outcome: `The automation ${need.subject.automation.id} is saved and switched on.`, told: `turn`, answeredBy: `demo@intentic.dev` }
                    : { ...need, status: `working`, answeredBy: `demo@intentic.dev` };
            case `apply`:
            case `grant`:
            case `release`:
                return { ...need, status: `met`, outcome: `Done.`, told: `turn`, answeredBy: `demo@intentic.dev` };
        }
    });

// The value is never kept: the demo stores nothing, it only says what the daemon would.
export const provideDemoSecret = (id: string): Need =>
    settle(id, (need) => ({
        ...need,
        status: `met`,
        outcome: need.subject.kind === `secret` ? `${need.subject.name} is stored.` : `Done.`,
        told: `turn`,
        answeredBy: `demo@intentic.dev`,
    }));

// The yeses still standing, for the inbox's "What you have allowed": a folder the checkout agent was let into beyond its
// persona's fence, its installs let run without asking, its Stripe key let past its host guard, and its key-rotation
// helper allowed everything, by the same demo person who answers everything here.
// Taking one back moves this store.
let grants: StandingGrants[`conversations`] | undefined;

export const demoGrants = (now: number = Date.now()): StandingGrants => {
    grants ??= [
        {
            conversationId: FEATURED_AGENT_ID,
            capabilities: [],
            folders: [`refs/stripe-samples`],
            shelves: [],
            installs: true,
            secrets: [`stripe/secret-key`],
            everything: false,
            by: `demo@intentic.dev`,
            updatedAt: now - minutes(42),
            releases: [],
        },
        {
            conversationId: `sub-keen-moth-5r8t`,
            capabilities: [],
            folders: [],
            shelves: [],
            installs: false,
            secrets: [],
            everything: true,
            by: `demo@intentic.dev`,
            updatedAt: now - minutes(1),
            releases: [],
        },
    ];
    return { conversations: grants };
};

type DemoGrantRow = StandingGrants[`conversations`][number];

const withoutGrant = (conversation: DemoGrantRow, grant: GrantRevoke): DemoGrantRow => {
    if (grant.kind === `install`) {
        return { ...conversation, installs: false };
    }
    if (grant.kind === `everything`) {
        return { ...conversation, everything: false };
    }
    if (grant.kind === `release`) {
        return { ...conversation, releases: conversation.releases.filter((release) => release.subject !== grant.what) };
    }
    const field = ({ capability: `capabilities`, folder: `folders`, shelf: `shelves`, secret: `secrets` } as const)[grant.kind];
    return { ...conversation, [field]: conversation[field].filter((what: string) => what !== grant.what) };
};

export const revokeDemoGrant = (grant: GrantRevoke): void => {
    grants = demoGrants()
        .conversations.map((conversation) => (conversation.conversationId === grant.conversationId ? withoutGrant(conversation, grant) : conversation))
        .filter(
            (conversation) =>
                conversation.installs ||
                conversation.everything ||
                conversation.capabilities.length +
                    conversation.folders.length +
                    conversation.shelves.length +
                    conversation.secrets.length +
                    conversation.releases.length >
                    0,
        );
};
