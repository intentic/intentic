// Text that reaches a PowerShell command line as data. A quoted literal cannot carry arbitrary text: PowerShell reads the
// typographic quotes ‘ ’ ‚ ‛ as single quotes beside ', so doubling ASCII quotes leaves a way out of the literal (and
// "..." expands `$(...)` and backticks). Base64 has no character PowerShell reads as syntax, whatever the text is.
export const psText = (text: string): string =>
    `([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(text, "utf8").toString("base64")}')))`;

// Prepended to a script whose output is read back. powershell.exe writes a redirected stdout in the console's OEM code
// page (852 on a Polish Windows) and every reader here decodes UTF-8, so a window titled "Zażółć" came back as U+FFFD.
// The encoding without a BOM: one at the front of a JSON answer is a character JSON.parse refuses.
export const PS_UTF8_OUTPUT = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
`;
