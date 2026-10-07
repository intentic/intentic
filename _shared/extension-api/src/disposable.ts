// What every registration hands back, in both halves of the api. A leaf of its own so the backend half (server.ts) reaches
// it without the browser half's types, which name Vue's.
export interface Disposable {
    dispose(): void;
}
