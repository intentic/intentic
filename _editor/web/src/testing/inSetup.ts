import { type App, createApp, effectScope, type InjectionKey } from "vue";

// One value an ancestor would provide, typed by its key so a fake that no longer matches the seam fails to compile.
export type Provided = { readonly key: InjectionKey<unknown> | string; readonly value: unknown };

export const provided = <V>(key: InjectionKey<V> | string, value: V): Provided => ({ key, value });

export type SetupHost = {
    // What an ancestor component provides: the seams the composable injects, each handed its one fake.
    readonly provides?: readonly Provided[];
    // What main.ts installs on the app the composable needs (vue-query's client, i18n), each as `(app) => app.use(…)`.
    readonly plugins?: readonly ((app: App) => void)[];
};

// What inSetup hands back: the composable's own result, the app it ran under, and the scope's stop.
export type SetUp<T> = { readonly result: T; readonly app: App; readonly stop: () => void };

/**
 * Runs `use` where a mounted component would run it, inside an app's injection context and an effect scope, so a
 * suite hands a composable its seams through `provide` rather than replacing modules by path. `stop` ends the scope,
 * which stops every watcher and computed the composable started.
 */
export const inSetup = <T>(use: () => T, host: SetupHost = {}): SetUp<T> => {
    const app = createApp({});
    for (const install of host.plugins ?? []) {
        install(app);
    }
    for (const { key, value } of host.provides ?? []) {
        app.provide(key, value);
    }
    const scope = effectScope();
    // A box, so a composable that returns undefined is told apart from a scope that refused to run.
    const ran = app.runWithContext(() => scope.run(() => ({ result: use() })));
    if (ran === undefined) {
        throw new Error(`inSetup: the effect scope was already stopped`);
    }
    return { result: ran.result, app, stop: () => scope.stop() };
};
