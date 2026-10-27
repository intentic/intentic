import { inviteRecords } from "../fixture/access";
import { signedOut } from "../mode";
import { DEMO_USER } from "../world/account";
import { acceptInvite, previewInvite } from "../world/invites";
import { membershipsOf } from "../world/organisations";
import { planState } from "../world/plan";
import { sandboxRows } from "../world/sandboxRegistry";
import type { PlatformRouter } from "./serve";

// WHO IS SIGNED IN, AND WHO THEY SHARE WITH: the account, and the platform's half of the Access tab.

// How long the platform takes to gather every row it holds about the account, so the page's wait is seen.
const GATHER_MS = 1_500;

// The GDPR export, in the platform's own shape (me.routes.ts): every personal-data row about the account, credentials
// left out (session, OAuth and connect tokens are secrets, not personal data).
const exportOf = () => {
    const plan = planState();
    const owned = sandboxRows().filter((row) => row.role === `owner`);
    const now = new Date();
    return {
        user: DEMO_USER,
        sessions: [{ createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(), ipAddress: `203.0.113.24`, userAgent: navigator.userAgent }],
        accounts: [{ providerId: `google`, accountId: `104729384756102938475`, scope: `openid email profile`, createdAt: `2026-08-02T09:14:00.000Z` }],
        sandboxes: owned.map((row) => ({ id: row.id, name: row.name, image: row.image, daemonUrl: row.daemonUrl })),
        memberships: sandboxRows()
            .filter((row) => row.role !== `owner`)
            .map((row) => ({ sandboxId: row.id })),
        invitesSent: inviteRecords().map((record) => ({ email: record.email, role: record.role, status: record.status, createdAt: record.invitedAt })),
        organisations: membershipsOf(),
        hostedPlan: plan.status === undefined ? null : { status: plan.status, currentPeriodEnd: plan.renewsAt ?? null },
        hostedUsage: (plan.hosted?.machines ?? []).map((machine) => ({ month: now.toISOString().slice(0, 7), tier: machine.tier, minutes: machine.hours.usedMinutes })),
        hostedProvisions: [],
        hostedStrikes: [],
        hostedSuspended: null,
    };
};

export const meAnswers = {
    get: () => (signedOut ? null : DEMO_USER),
    export: async () => {
        await new Promise((resolve) => setTimeout(resolve, GATHER_MS));
        return exportOf();
    },
    // Both ways in, as the live platform offers them: the sign-in screens and the desktop app's dialog draw both.
    signInOptions: () => ({ google: true, email: true }),
} satisfies NonNullable<PlatformRouter[`me`]>;

// The accept link a demo invite hands back, pointing at the demo's own copy of that page.
const INVITE_LINK = `${window.location.origin}${import.meta.env.BASE_URL}invite/demo-token`;

// The platform's half of the Access tab. Its shape is the contract's (`members`, never `invites`), and its writes
// are the mirror the real ones are: the tier and the cards were already pushed to the daemon by the owner's browser
// before any of these is called, so each answers with the roster rather than writing it again.
// A demo platform can't send mail, which is the `local-link` an owner is handed instead.
const roster = () => ({ members: inviteRecords() });
const sent = () => ({ members: inviteRecords(), link: INVITE_LINK, delivery: `local-link` as const });

export const inviteAnswers = {
    list: roster,
    setRole: roster,
    revoke: roster,
    create: sent,
    resend: sent,
    // The standalone accept page (/demo/invite/:token), played as the invitee (world/invites.ts).
    preview: ({ token }) => previewInvite(token),
    accept: ({ token }) => ({ sandboxId: acceptInvite(token) }),
} satisfies NonNullable<PlatformRouter[`invite`]>;
