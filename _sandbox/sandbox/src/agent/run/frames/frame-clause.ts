// The provider's sentence, then the daemon's; one the provider left unpunctuated ("Prompt is too long") gets its stop.
// Shared by the failures whose frame says where the turn goes next, which the reader cannot see (classify-failure.ts
// overflow, memory-death.ts).
export const withClause = (message: string, clause: string): string => {
    const said = message.trimEnd();
    return `${said}${/[.!?]$/.test(said) ? "" : "."} ${clause}`;
};
