import type { SignInMethod } from "@intentic/api-contract";
import { ref } from "vue";

// HOW THE SIGNED-IN ACCOUNT PROVES ITS ADDRESS: a Google sign-in, a code mailed to it, or both. It decides which proof
// the editor spends on a daemon (sandboxSession.ts: the platform's identity assertion only for an `email` account, and
// never Google's prompt for an account that has no Google sign-in). Its own module so the session module can read it
// without importing useAuth.ts, which imports the session module; useAuth writes it whenever it learns the account.

export interface AccountWaysIn {
    readonly email: string;
    // Absent from a platform from before email sign-in (see methodsOf).
    readonly methods: readonly SignInMethod[] | undefined;
}

// allow(module-state): the signed-in account's address and ways in, above every sandbox, written only by useAuth
export const accountWaysIn = ref<AccountWaysIn | undefined>(undefined);

// A platform from before email sign-in says nothing, and every account it holds is a Google one.
export const methodsOf = (methods: readonly SignInMethod[] | undefined): readonly SignInMethod[] => methods ?? [`google`];

export const signsInByEmail = (methods: readonly SignInMethod[] | undefined): boolean => methodsOf(methods).includes(`email`);

export const signsInWithGoogle = (methods: readonly SignInMethod[] | undefined): boolean => methodsOf(methods).includes(`google`);

// An account with no Google sign-in at all: Google's prompt would sign in somebody else, or nobody.
export const emailOnly = (methods: readonly SignInMethod[] | undefined): boolean => signsInByEmail(methods) && !signsInWithGoogle(methods);

// Whether an address is one Google itself holds, where its sign-in is the faster road (a hint, never a block).
export const googleMailbox = (address: string): boolean => /@(gmail|googlemail)\.com$/i.test(address.trim());
