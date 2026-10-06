// A route template's `{param}` names, read off the template itself so a caller cannot leave one out.
export type RoutePathParams<Path extends string> = Path extends `${string}{${infer Name}}${infer Rest}` ? Name | RoutePathParams<Rest> : never;

// A route template with each `{param}` filled by its value, encoded as exactly one path segment. A value missing for a
// name the template carries throws: the path it would build names some other route.
export const fillRoutePath = (template: string, params: Readonly<Record<string, string>> = {}): string =>
    template.replace(/\{([^}]+)\}/gu, (_, name: string) => {
        const value = params[name];
        if (value === undefined) {
            throw new Error(`${template} needs a value for {${name}}`);
        }
        return encodeURIComponent(value);
    });
