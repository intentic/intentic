import { z } from "zod";

// The one channel that changes what this process serves: JSON lines on stdin from the desktop app that started it,
// answered as JSON lines on stdout. A page can only present a token; only the app, which holds this process's stdin,
// can say which folder a token opens. The process ends when that stdin does, so it never outlives the app.

const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

export const ControlMessageSchema = z.discriminatedUnion(`op`, [
    z.object({
        op: z.literal(`grant`),
        token: TokenSchema,
        // The window's own id, which keys the editor's state for it; the app keeps it across reopenings of one path.
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        // Absolute, as the app resolved it from the user's own choice.
        path: z.string().min(1),
        kind: z.enum([`folder`, `file`]),
    }),
    z.object({ op: z.literal(`revoke`), token: TokenSchema }),
]);
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

// What this process tells the app. `granted` carries what the app shows (the folder served, the name) and `refused` why
// a path could not be served.
export type ControlEvent =
    | { readonly event: `ready`; readonly port: number; readonly version: string }
    | { readonly event: `granted`; readonly token: string; readonly root: string; readonly name: string; readonly file?: string | undefined }
    | { readonly event: `refused`; readonly token: string; readonly error: string }
    | { readonly event: `revoked`; readonly token: string };

// One line in, a message or why it is not one.
export const parseControlLine = (line: string): ControlMessage | { readonly error: string } => {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return { error: `not JSON: ${line.slice(0, 80)}` };
    }
    const parsed = ControlMessageSchema.safeParse(value);
    return parsed.success ? parsed.data : { error: parsed.error.issues.map((issue) => `${issue.path.join(`.`)}: ${issue.message}`).join(`; `) };
};

export const controlLine = (event: ControlEvent): string => `${JSON.stringify(event)}\n`;
