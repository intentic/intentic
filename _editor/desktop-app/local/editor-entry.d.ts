// The editor's entry, imported for its effect only: _editor/web type-checks what is behind it. tsconfig.local.json's
// paths resolve the import to this file too, since without that the program would still follow it into the editor's
// source and check it under settings that are not the editor's.
declare module "@intentic/web/main";
