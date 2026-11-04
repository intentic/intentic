import { parseJsonWith } from "@intentic/base/json";
import { type User, UserSchema } from "@intentic/api-contract";
import { z } from "zod";

/* THE ACCOUNT'S ANSWERS TO A LOCAL WINDOW (localHost.ts `account` and the calls beside it), as the app hands their text
   over (its src/account.ts): Better Auth's, read as useAuth.ts reads them. Text that is not JSON (a proxy's error page)
   says nothing, as an answer out of shape says nothing. */

/**
 * One of the accounts signed in on the workspace's browser profile, beside one another (Better Auth's device sessions),
 * with the token that names it to the platform: the same shape as the workspace's own list (useAuth.ts `DeviceSession`).
 */
export interface LocalDeviceAccount {
    readonly token: string;
    readonly user: User;
}

// `get-session` answers `{ session, user }`, or `null` for nobody. Only what the editor's User holds is kept; a user
// with no name or picture has them empty, and an answer out of shape is nobody rather than half someone.
const PlatformUserSchema = UserSchema.extend({ name: z.string().catch(``), image: z.string().nullable().catch(null) });
const SessionAnswerSchema = z.object({ user: PlatformUserSchema }).nullable();

export const accountOfSession = (text: string): User | null => {
    return parseJsonWith(text, SessionAnswerSchema)?.user ?? null;
};

// `list-device-sessions` answers one `{ session, user }` per account signed in. An entry out of shape is left out
// rather than the whole list lost: the rest can still be switched to.
const DeviceAccountSchema = z.object({ session: z.object({ token: z.string().min(1) }), user: PlatformUserSchema });
const DeviceAccountsSchema = z.array(z.unknown());

export const deviceAccountsOf = (text: string): readonly LocalDeviceAccount[] =>
    (parseJsonWith(text, DeviceAccountsSchema) ?? []).flatMap((entry) => {
        const parsed = DeviceAccountSchema.safeParse(entry);
        return parsed.success ? [{ token: parsed.data.session.token, user: parsed.data.user }] : [];
    });

// A refusal's sentence, which Better Auth and oRPC both say as `message`.
const RefusalSchema = z.object({ message: z.string().min(1) });

export const refusalOf = (text: string): string | undefined => {
    return parseJsonWith(text, RefusalSchema)?.message;
};
