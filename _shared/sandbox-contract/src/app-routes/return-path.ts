import { z } from "zod";

// Where a sign-in returns to, read off whatever carried it (the sign-in page's query, the sign-in mail's link): a plain
// rooted path on the editor's own origin, or `/`. The editor uses it as a router target and as `origin + this` for
// Better Auth's OAuth callback, and the platform writes it into the sign-in mail's link, so protocol-relative values
// (`//host`, `/\\host`) are refused. So is any control character: the URL parser drops a tab or a newline, which turns
// `/\t/host` into `//host` after this check has passed it.
// (2026-11-23) Here rather than in the editor, so the platform validates a destination with the same rule before it
// goes into a mail, and the editor again before it navigates there.
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ReturnPathSchema = z
    .string()
    .regex(/^\/(?![/\\])/u)
    .refine((path) => !CONTROL.test(path));
// This is the parser at the boundary: a router query value (a string, null, an array of them) or a request's raw field.
export const returnPath = (returnTo: unknown): string => ReturnPathSchema.safeParse(returnTo).data ?? `/`;
