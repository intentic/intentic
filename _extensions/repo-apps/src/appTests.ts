/* Split a repo's vitest project dirs into three buckets for the merged AppsView: • byApp. */

export interface GroupedTests {
    readonly byApp: Map<string, string[]>;
    readonly packages: Map<string, string[]>;
    readonly libraries: string[];
}

const pushInto = (map: Map<string, string[]>, key: string, project: string): void => {
    const dirs = map.get(key);
    if (dirs === undefined) {
        map.set(key, [project]);
    } else {
        dirs.push(project);
    }
};

export const groupTests = (projects: readonly string[], apps: readonly string[], repo: string): GroupedTests => {
    const appsPrefix = `${repo}/_apps/`;
    const appSet = new Set(apps);
    const byApp = new Map<string, string[]>();
    const packages = new Map<string, string[]>();
    const libraries: string[] = [];
    for (const project of projects) {
        if (!project.startsWith(appsPrefix)) {
            libraries.push(project);
            continue;
        }
        const name = project.slice(appsPrefix.length).split(`/`)[0] ?? ``;
        pushInto(appSet.has(name) ? byApp : packages, name, project);
    }
    return { byApp, packages, libraries };
};
