// Text that reaches a PowerShell command line as data. A quoted literal cannot carry arbitrary text: PowerShell reads the
// typographic quotes ‘ ’ ‚ ‛ as single quotes beside ', so doubling ASCII quotes leaves a way out of the literal (and
// "..." expands `$(...)` and backticks). Base64 has no character PowerShell reads as syntax, whatever the text is.
export const psText = (text: string): string =>
    `([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(text, "utf8").toString("base64")}')))`;
