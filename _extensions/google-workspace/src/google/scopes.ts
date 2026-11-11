import { googleWorkspaceScopes } from "@intentic/sandbox-contract/oauth/google-workspace";
import type { AccessLevel } from "./accounts.js";

// What the card's read-only switch buys. The lists live in the sandbox contract, since the platform's Connect Google
// client asks for the same ones. A user card switched to read-only after consent still holds a write-capable token,
// which is why the command-level guard also exists.

export const scopesFor = (access: AccessLevel): string[] => googleWorkspaceScopes(access);
