import { effectScope, watch } from "vue";
import { externalDirtyPaths, setExternalDirty } from "./externalDirty";

// What an editor keeping its own document (the office suite's) reports of its unsaved edits, as the local window's
// close guard reads it.

test("a path is marked and cleared, each change a new set its readers hear once", () => {
    const heard: string[][] = [];
    const scope = effectScope();
    scope.run(() => watch(externalDirtyPaths, (paths) => heard.push([...paths].toSorted()), { flush: `sync` }));
    setExternalDirty(`a.docx`, true);
    setExternalDirty(`b.xlsx`, true);
    const held = externalDirtyPaths.value;
    // Saying what is already so changes nothing, so nobody is told twice.
    setExternalDirty(`a.docx`, true);
    setExternalDirty(`c.pptx`, false);
    setExternalDirty(`a.docx`, false);
    setExternalDirty(`b.xlsx`, false);
    scope.stop();
    expect(heard).toEqual([[`a.docx`], [`a.docx`, `b.xlsx`], [`b.xlsx`], []]);
    // A set once handed out is never edited under its reader.
    expect([...held].toSorted()).toEqual([`a.docx`, `b.xlsx`]);
});
