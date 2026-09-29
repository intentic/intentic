import { z } from "zod";

// The one channel that changes what this process serves: JSON lines on stdin from the desktop app that started it,
// answered as JSON lines on stdout. A page can only present a token; only the app, which holds this process's stdin,
// can say which folder a token opens. The process ends when that stdin does, so it never outlives the app. The channel
// also runs the other way: this process asks the app for what only the app may do (`ask`), and the app answers by id.

const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

// A page's exact origin, `https://app.intentic.dev`: a scheme, a host and a port where it has one, and nothing after.
const OriginSchema = z.string().refine((value) => {
    try {
        const url = new URL(value);
        return (url.protocol === `https:` || url.protocol === `http:`) && url.origin === value;
    } catch {
        // allow(silent-catch): a value that does not parse as a URL is not an origin, which the false says.
        return false;
    }
}, `not an origin such as https://app.intentic.dev`);

export const ControlMessageSchema = z.discriminatedUnion(`op`, [
    z.object({
        op: z.literal(`grant`),
        token: TokenSchema,
        // The window's own id, which keys the editor's state for it; the app keeps it across reopenings of one path.
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        // Absolute, as the app resolved it from the user's own choice.
        path: z.string().min(1),
        kind: z.enum([`folder`, `file`]),
        // Nothing may be written through it: no save, drop, move, copy, new folder or delete.
        readOnly: z.boolean().optional(),
        // A handoff: the document's bytes for pages of these origins only, and nothing else (grants.ts).
        origins: z.array(OriginSchema).min(1).max(16).optional(),
        // How long the token opens anything; after it, it answers as one never granted.
        expiresInMs: z.number().int().positive().optional(),
    }),
    z.object({ op: z.literal(`revoke`), token: TokenSchema }),
    // The app's answer to an `ask`, by its id: done, or why not.
    z.object({ op: z.literal(`answer`), id: z.string().min(1).max(128), ok: z.boolean(), error: z.string().max(2000).optional() }),
    // Fetch the office editor now, with no document open, so the first one opens without the wait.
    z.object({ op: z.literal(`prefetch-office`) }),
]);
export type ControlMessage = z.infer<typeof ControlMessageSchema>;
export type AnswerMessage = Extract<ControlMessage, { readonly op: `answer` }>;

// What this process asks the app to do: `trash` moves the entry at `path` (absolute, with no link in it) to the
// system's Recycle Bin or Trash, which nothing but a program the user runs should do on their behalf.
export type AskVerb = `trash`;

// What this process tells the app. `granted` carries what the app shows (the folder served, the name) and `refused` why
// a path could not be served. `ask` wants an `answer` line back with its id. `office` says where the editor's download
// ended, after a `prefetch-office`.
export type ControlEvent =
    | { readonly event: `ready`; readonly port: number; readonly version: string }
    | { readonly event: `granted`; readonly token: string; readonly root: string; readonly name: string; readonly file?: string | undefined }
    | { readonly event: `refused`; readonly token: string; readonly error: string }
    | { readonly event: `revoked`; readonly token: string }
    | { readonly event: `ask`; readonly id: string; readonly verb: AskVerb; readonly path: string }
    | { readonly event: `office`; readonly state: `ready` }
    | { readonly event: `office`; readonly state: `failed`; readonly error: string };

// One line in, a message or why it is not one. Named apart from every message's own fields: an `answer` carries an
// `error` of its own.
export const parseControlLine = (line: string): ControlMessage | { readonly invalid: string } => {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return { invalid: `not JSON: ${line.slice(0, 80)}` };
    }
    const parsed = ControlMessageSchema.safeParse(value);
    return parsed.success ? parsed.data : { invalid: parsed.error.issues.map((issue) => `${issue.path.join(`.`)}: ${issue.message}`).join(`; `) };
};

export const controlLine = (event: ControlEvent): string => `${JSON.stringify(event)}\n`;
