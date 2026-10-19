// WHAT THE HOST KEEPS IN ITS ADDRESS for the app: the index entry (model.ts `filterKey`, or `settings`), the password
// open, and the search. The desktop app carries it in its route's query, so a deep link and the back button land where
// the reader was.
export interface PasswordsSelection {
    readonly filter?: string | undefined;
    readonly item?: string | undefined;
    readonly query?: string | undefined;
}
