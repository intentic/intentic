// VS Code's own quick-open ranking cases, replayed through topByFuzzy: the `compareFilesByScore` tests from
// src/vs/base/test/common/fuzzyScorer.test.ts (lines 643-1139 at the copy under refs/vscode), from "prefer shorter
// paths (bug #17443)" on. Copyright (c) Microsoft Corporation, MIT License. Each case keeps VS Code's files, queries and
// the order its assertions pin (only the first file where VS Code asserts only that); `line` is where the case starts.
//
// Two cases are missed on purpose: both ask for the path whose case matches the query exactly, and this scorer ignores
// case (it reads the original case only for camelCase humps). Their `ours` is the order we answer instead.
import { topByFuzzy } from "./fuzzy.js";

interface VsCodeCase {
    readonly line: number;
    readonly name: string;
    readonly files: readonly string[];
    // Each query with the order VS Code's assertions pin for it.
    readonly expect: readonly (readonly [query: string, order: readonly string[]])[];
    // A deliberate miss: what this scorer answers instead, and why.
    readonly ours?: { readonly order: readonly (readonly string[])[]; readonly why: string };
}

const each = (queries: readonly string[], order: readonly string[]): [string, readonly string[]][] => queries.map((query) => [query, order]);

const CASES: readonly VsCodeCase[] = [
    {
        line: 643,
        name: "prefer shorter paths (bug #17443)",
        files: ["config/test/t1.js", "config/test.js", "config/test/t2.js"],
        expect: [["co/te", ["config/test.js", "config/test/t1.js", "config/test/t2.js"]]],
    },
    {
        line: 656,
        name: "prefer matches in label over description if scores are otherwise equal",
        files: ["parts/quick/arrow-left-dark.svg", "parts/quickopen/quickopen.ts"],
        expect: [["partsquick", ["parts/quickopen/quickopen.ts", "parts/quick/arrow-left-dark.svg"]]],
    },
    {
        line: 667,
        name: "prefer camel case matches",
        files: ["config/test/NullPointerException.java", "config/test/nopointerexception.java"],
        expect: each(["npe", "NPE"], ["config/test/NullPointerException.java", "config/test/nopointerexception.java"]),
    },
    {
        line: 682,
        name: "prefer more compact camel case matches",
        files: ["config/test/openthisAnythingHandler.js", "config/test/openthisisnotsorelevantforthequeryAnyHand.js"],
        expect: [["AH", ["config/test/openthisisnotsorelevantforthequeryAnyHand.js", "config/test/openthisAnythingHandler.js"]]],
    },
    {
        line: 697,
        name: "prefer more compact matches (label)",
        files: ["config/test/examasdaple.js", "config/test/exampleasdaasd.ts"],
        expect: [["xp", ["config/test/exampleasdaasd.ts", "config/test/examasdaple.js"]]],
    },
    {
        line: 712,
        name: "prefer more compact matches (path)",
        files: ["config/test/examasdaple/file.js", "config/test/exampleasdaasd/file.ts"],
        expect: [["xp", ["config/test/exampleasdaasd/file.ts", "config/test/examasdaple/file.js"]]],
    },
    {
        line: 727,
        name: "prefer more compact matches (label and path)",
        files: ["config/example/thisfile.ts", "config/24234243244/example/file.js"],
        expect: [["exfile", ["config/24234243244/example/file.js", "config/example/thisfile.ts"]]],
    },
    {
        line: 742,
        name: "avoid match scattering (bug #34210)",
        files: [
            "node_modules1/bundle/lib/model/modules/ot1/index.js",
            "node_modules1/bundle/lib/model/modules/un1/index.js",
            "node_modules1/bundle/lib/model/modules/modu1/index.js",
            "node_modules1/bundle/lib/model/modules/oddl1/index.js",
        ],
        expect: [
            ["modu1/index.js", ["node_modules1/bundle/lib/model/modules/modu1/index.js"]],
            ["un1/index.js", ["node_modules1/bundle/lib/model/modules/un1/index.js"]],
        ],
    },
    {
        line: 765,
        name: "avoid match scattering (bug #21019 1.)",
        files: [
            "app/containers/Services/NetworkData/ServiceDetails/ServiceLoad/index.js",
            "app/containers/Services/NetworkData/ServiceDetails/ServiceDistribution/index.js",
            "app/containers/Services/NetworkData/ServiceDetailTabs/ServiceTabs/StatVideo/index.js",
        ],
        expect: [["StatVideoindex", ["app/containers/Services/NetworkData/ServiceDetailTabs/ServiceTabs/StatVideo/index.js"]]],
    },
    {
        line: 779,
        name: "avoid match scattering (bug #21019 2.)",
        files: ["src/build-helper/store/redux.ts", "src/repository/store/redux.ts"],
        expect: [["reproreduxts", ["src/repository/store/redux.ts"]]],
    },
    {
        line: 792,
        name: "avoid match scattering (bug #26649)",
        files: [
            "photobook/src/components/AddPagesButton/index.js",
            "photobook/src/components/ApprovalPageHeader/index.js",
            "photobook/src/canvasComponents/BookPage/index.js",
        ],
        expect: [["bookpageIndex", ["photobook/src/canvasComponents/BookPage/index.js"]]],
    },
    {
        line: 806,
        name: "avoid match scattering (bug #33247)",
        files: ["ui/src/utils/constants.js", "ui/src/ui/Icons/index.js"],
        expect: [["ui/icons", ["ui/src/ui/Icons/index.js"]]],
    },
    {
        line: 819,
        name: "avoid match scattering (bug #33247 comment)",
        files: ["ui/src/components/IDInput/index.js", "ui/src/ui/Input/index.js"],
        expect: [["ui/input/index", ["ui/src/ui/Input/index.js"]]],
    },
    {
        line: 832,
        name: "avoid match scattering (bug #36166)",
        files: ["django/contrib/sites/locale/ga/LC_MESSAGES/django.mo", "django/core/signals.py"],
        expect: [["djancosig", ["django/core/signals.py"]]],
    },
    {
        line: 845,
        name: "avoid match scattering (bug #32918)",
        files: [
            "adsys/protected/config.php",
            "adsys/protected/framework/smarty/sysplugins/smarty_internal_config.php",
            "duowanVideo/wap/protected/config.php",
        ],
        expect: [
            [
                "protectedconfig.php",
                [
                    "adsys/protected/config.php",
                    "duowanVideo/wap/protected/config.php",
                    "adsys/protected/framework/smarty/sysplugins/smarty_internal_config.php",
                ],
            ],
        ],
    },
    {
        line: 863,
        name: "avoid match scattering (bug #14879)",
        files: ["pkg/search/gradient/testdata/constraint_attrMatchString.yml", "cmd/gradient/main.go"],
        expect: [["gradientmain", ["cmd/gradient/main.go"]]],
    },
    {
        line: 876,
        name: "avoid match scattering (bug #14727 1)",
        files: ["alpha-beta-cappa.txt", "abc.txt"],
        expect: [["abc", ["abc.txt"]]],
    },
    {
        line: 889,
        name: "avoid match scattering (bug #14727 2)",
        files: ["xerxes-yak-zubba/index.js", "xyz/index.js"],
        expect: [["xyz", ["xyz/index.js"]]],
    },
    {
        line: 902,
        name: "avoid match scattering (bug #18381)",
        files: ["AssymblyInfo.cs", "IAsynchronousTask.java"],
        expect: [["async", ["IAsynchronousTask.java"]]],
    },
    {
        line: 915,
        name: "avoid match scattering (bug #35572)",
        files: [
            "static/app/source/angluar/-admin/-organization/-settings/layout/layout.js",
            "static/app/source/angular/-admin/-project/-settings/_settings/settings.js",
        ],
        expect: [["partisettings", ["static/app/source/angular/-admin/-project/-settings/_settings/settings.js"]]],
    },
    {
        line: 928,
        name: "avoid match scattering (bug #36810)",
        files: ["Trilby.TrilbyTV.Web.Portal/Views/Systems/Index.cshtml", "Trilby.TrilbyTV.Web.Portal/Areas/Admins/Views/Tips/Index.cshtml"],
        expect: [["tipsindex.cshtml", ["Trilby.TrilbyTV.Web.Portal/Areas/Admins/Views/Tips/Index.cshtml"]]],
    },
    {
        line: 941,
        name: "prefer shorter hit (bug #20546)",
        files: ["editor/core/components/tests/list-view-spec.js", "editor/core/components/list-view.js"],
        expect: [["listview", ["editor/core/components/list-view.js"]]],
    },
    {
        line: 954,
        name: "avoid match scattering (bug #12095)",
        files: [
            "src/vs/workbench/contrib/files/common/explorerViewModel.ts",
            "src/vs/workbench/contrib/files/browser/views/explorerView.ts",
            "src/vs/workbench/contrib/files/browser/views/explorerViewer.ts",
        ],
        expect: [["filesexplorerview.ts", ["src/vs/workbench/contrib/files/browser/views/explorerView.ts"]]],
    },
    {
        line: 968,
        name: "prefer case match (bug #96122)",
        files: ["lists.php", "lib/Lists.php"],
        expect: [["Lists.php", ["lib/Lists.php"]]],
        ours: { order: [["lists.php"]], why: "case is ignored, so the two names tie and the shorter path wins" },
    },
    {
        line: 981,
        name: "prefer shorter match (bug #103052) - foo bar",
        files: ["app/emails/foo.bar.js", "app/emails/other-footer.other-bar.js"],
        expect: each(["foo bar", "foobar"], ["app/emails/foo.bar.js", "app/emails/other-footer.other-bar.js"]),
    },
    {
        line: 996,
        name: "prefer shorter match (bug #103052) - payment model",
        files: ["app/components/payment/payment.model.js", "app/components/online-payments-history/online-payments-history.model.js"],
        expect: each(
            ["payment model", "paymentmodel"],
            ["app/components/payment/payment.model.js", "app/components/online-payments-history/online-payments-history.model.js"],
        ),
    },
    {
        line: 1011,
        name: "prefer shorter match (bug #103052) - color",
        files: ["app/constants/color.js", "app/components/model/input/pick-avatar-color.js"],
        expect: each(["color js", "colorjs"], ["app/constants/color.js", "app/components/model/input/pick-avatar-color.js"]),
    },
    {
        line: 1026,
        name: "prefer strict case prefix",
        files: ["app/constants/color.js", "app/components/model/input/Color.js"],
        expect: [
            ["Color", ["app/components/model/input/Color.js", "app/constants/color.js"]],
            ["color", ["app/constants/color.js", "app/components/model/input/Color.js"]],
        ],
        ours: {
            order: [
                ["app/constants/color.js", "app/components/model/input/Color.js"],
                ["app/constants/color.js", "app/components/model/input/Color.js"],
            ],
            why: "case is ignored, so `Color` answers as `color` does: the shorter path first",
        },
    },
    {
        line: 1051,
        name: "prefer prefix (bug #103052)",
        files: ["test/smoke/src/main.ts", "src/vs/editor/common/services/semantikTokensProviderStyling.ts"],
        expect: [["smoke main.ts", ["test/smoke/src/main.ts", "src/vs/editor/common/services/semantikTokensProviderStyling.ts"]]],
    },
    {
        line: 1066,
        name: "boost better prefix match if multiple queries are used",
        files: ["src/vs/workbench/services/host/browser/browserHostService.ts", "src/vs/workbench/browser/workbench.ts"],
        expect: each(
            ["workbench.ts browser", "browser workbench.ts", "browser workbench", "workbench browser"],
            ["src/vs/workbench/browser/workbench.ts", "src/vs/workbench/services/host/browser/browserHostService.ts"],
        ),
    },
    {
        line: 1081,
        name: "boost shorter prefix match if multiple queries are used",
        files: ["src/vs/workbench/node/actions/windowActions.ts", "src/vs/workbench/electron-node/window.ts"],
        expect: each(["window node", "window.ts node"], ["src/vs/workbench/electron-node/window.ts", "src/vs/workbench/node/actions/windowActions.ts"]),
    },
    {
        line: 1096,
        name: "skip preference on label match when using path sep",
        files: ["djangosite/ufrela/def.py", "djangosite/urls/default.py"],
        expect: [["url/def", ["djangosite/urls/default.py", "djangosite/ufrela/def.py"]]],
    },
    {
        line: 1111,
        name: "boost shorter prefix match if multiple queries are used (#99171)",
        files: ["mesh_editor_lifetime_job.h", "lifetime_job.h"],
        expect: [["m life, life m", ["lifetime_job.h", "mesh_editor_lifetime_job.h"]]],
    },
    {
        line: 1126,
        name: "boost consecutive matches in the beginning over end",
        files: ["src/vs/server/node/extensionHostStatusService.ts", "src/vs/workbench/browser/parts/notifications/notificationsStatus.ts"],
        expect: [
            [
                "notStatus",
                ["src/vs/workbench/browser/parts/notifications/notificationsStatus.ts", "src/vs/server/node/extensionHostStatusService.ts"],
            ],
        ],
    },
];

// The first `count` paths topByFuzzy puts first, the same whichever order the files arrive in.
const firstPaths = (query: string, files: readonly string[], count: number): readonly string[] => {
    const ranked = topByFuzzy(query, files, files.length).ranked.map(({ path }) => path);
    expect(topByFuzzy(query, files.toReversed(), files.length).ranked.map(({ path }) => path)).toEqual(ranked);
    return ranked.slice(0, count);
};

test("the port keeps all 34 of VS Code's cases, so a case dropped from the table shows here", () => {
    expect(CASES).toHaveLength(34);
});

test.each(CASES.filter((entry) => entry.ours === undefined).map((entry) => [`${entry.line}: ${entry.name}`, entry] as const))(
    "VS Code %s",
    (_title, entry) => {
        for (const [query, order] of entry.expect) {
            expect([query, firstPaths(query, entry.files, order.length)]).toEqual([query, order]);
        }
    },
);

test.each(CASES.filter((entry) => entry.ours !== undefined).map((entry) => [`${entry.line}: ${entry.name}`, entry] as const))(
    "VS Code %s is missed on purpose",
    (_title, entry) => {
        entry.expect.forEach(([query, order], index) => {
            const ours = entry.ours!.order[index]!;
            expect([query, firstPaths(query, entry.files, order.length)]).toEqual([query, ours]);
        });
    },
);
