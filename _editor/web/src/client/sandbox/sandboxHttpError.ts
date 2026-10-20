// How a daemon refusal reads, for both clients (typed and raw). Free of client imports, so a suite that fakes a client
// can still throw the real class and code under test can still recognize it.

import { t } from "@intentic/ui/i18n";
import { z } from "zod";

// What a refusal's body said, field by field: an oRPC handler's `message`, a hand-written route's `error`.
export interface RefusalWords {
    readonly message?: string;
    readonly error?: string;
}

// A non-2xx daemon answer, carrying the HTTP status so callers can branch on it without matching message text, and the
// body's own words for the few that phrase a refusal themselves.
export class SandboxHttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly said: RefusalWords = {},
    ) {
        super(message);
    }
}

// A call's answer, or the daemon's refusal as a value to branch on; a call that got no answer at all still throws.
export const orRefusal = <T>(call: Promise<T>): Promise<T | SandboxHttpError> =>
    call.catch((error: unknown) => {
        if (error instanceof SandboxHttpError) {
            return error;
        }
        throw error;
    });

// How many refused fields a refusal names before it counts the rest.
const ISSUES_SHOWN = 3;

// A refusal's body as the daemon writes one: an oRPC handler's `message`, a hand-written route's `error`, and for a
// request its schema refused, oRPC's `data.issues` (each a message and the path to its field). Each part read on its
// own, so a body malformed in one part still says what the others do.
const PathSegmentSchema = z.union([z.string(), z.number(), z.object({ key: z.union([z.string(), z.number()]) })]);
const RefusalBodySchema = z.object({
    message: z.string().optional().catch(undefined),
    error: z.string().optional().catch(undefined),
    data: z
        .object({ issues: z.array(z.object({ message: z.string(), path: z.array(PathSegmentSchema).optional() })) })
        .optional()
        .catch(undefined),
});
type RefusalIssue = NonNullable<z.infer<typeof RefusalBodySchema>[`data`]>[`issues`][number];

const issueLine = ({ message, path = [] }: RefusalIssue): string => {
    const field = path.map((segment) => (typeof segment === `object` ? segment.key : segment)).join(`.`);
    return field === `` ? message : `${field}: ${message}`;
};

// The fields a schema refused, as one clause: `title: Too big: expected string to have <=80 characters`. The message
// beside them says only "Input validation failed", which names nothing to fix.
const issuesLine = (issues: readonly RefusalIssue[]): string | undefined => {
    if (issues.length === 0) {
        return undefined;
    }
    const more = issues.length - ISSUES_SHOWN;
    return [...issues.slice(0, ISSUES_SHOWN).map(issueLine), ...(more > 0 ? [`+${more}`] : [])].join(`; `);
};

// The words a refusal's body carries, whatever else it holds: a validation refusal's message names the fields it refused.
export const wordsOf = (body: unknown): RefusalWords => {
    const parsed = RefusalBodySchema.safeParse(body);
    if (!parsed.success) {
        return {};
    }
    const { message, error, data } = parsed.data;
    const issues = issuesLine(data?.issues ?? []);
    const named = issues === undefined ? message : message === undefined ? issues : `${message} (${issues})`;
    return { ...(named === undefined ? {} : { message: named }), ...(error === undefined ? {} : { error }) };
};

// The daemon's own words for a refusal: its `message`, else a hand-written route's `error`, else the bare status.
export const refusalText = (status: number, said: RefusalWords): string =>
    said.message ?? said.error ?? t(`sandbox.sandboxClient.requestFailed`, { status });
