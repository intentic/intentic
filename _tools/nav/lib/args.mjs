// Reads `--name value` flags from argv for scripts run by hand or CI; unknown flags are ignored. A flag named last in
// argv with no value yields fallback, not the string "undefined".
export const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1];
};
