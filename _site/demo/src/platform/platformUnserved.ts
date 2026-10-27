import type { PLATFORM_ANSWERS } from "../platform";
import type { PlatformRoute } from "./serve";

// Every api-contract procedure the demo's platform leaves unanswered, and why: the platform's half of the demo's
// coverage, stated as unserved.ts states the daemon's. The typecheck holds this list to the contract both ways: a
// procedure neither answered (platform.ts) nor listed here is a missing property, and one listed here that platform.ts
// now answers, or that the contract dropped, is an unknown one. So a new procedure lands with a decision.

type Answers = typeof PLATFORM_ANSWERS;
type Served = { readonly [G in keyof Answers]: `${G & string}.${keyof Answers[G] & string}` }[keyof Answers];
type Unserved = Exclude<PlatformRoute, Served>;

// Out of the demo by design: nothing a visitor's editor sends reaches these.
const OPERATORS = `The operators' console: only the platform's own staff reach it, and the demo account is not one of them.`;
const NOT_THE_BROWSER = `Sent by the desktop app or a phone, never by the editor in a browser tab.`;
const NOT_THE_EDITORS = `Sent by a sandbox's daemon to wake a phone, never by the editor.`;

const PLATFORM_UNSERVED = {
    "admin.attention": OPERATORS,
    "admin.costs": OPERATORS,
    "admin.funnel": OPERATORS,
    "admin.machineStop": OPERATORS,
    "admin.overview": OPERATORS,
    "admin.trends": OPERATORS,
    "admin.user": OPERATORS,
    "admin.userDelete": OPERATORS,
    "admin.userSuspend": OPERATORS,
    "admin.userUnsuspend": OPERATORS,
    "admin.users": OPERATORS,
    "push.send": NOT_THE_EDITORS,
    "push.unregister": NOT_THE_BROWSER,
} as const satisfies Readonly<Record<Unserved, string>>;

/** Why the demo leaves a procedure unanswered, by the contract's name for it; undefined for one it answers. */
export const platformUnservedReason = (route: string | undefined): string | undefined =>
    Object.entries(PLATFORM_UNSERVED).find(([name]) => name === route)?.[1];
