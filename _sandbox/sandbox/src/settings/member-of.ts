import type { OrpcContext } from "../app-env.js";

// Whose record a person's own settings call reads and writes (their words, their checklist, their AI literacy
// confirmation): the verified address, lower-cased, and "" for the one person of a sandbox nobody signs in to (loopback).
export const memberOf = (context: OrpcContext): string => context.identity?.email.toLowerCase() ?? "";
