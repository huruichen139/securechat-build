if (!("finalizeConstruction" in ViewPU.prototype)) {
    Reflect.set(ViewPU.prototype, "finalizeConstruction", () => { });
}
interface Index_Params {
    controller?: webview.WebviewController;
    startUrl?: string;
}
import webview from "@ohos:web.webview";
class Index extends ViewPU {
    constructor(o, p, q, r = -1, s = undefined, t) {
        super(o, q, r, t);
        if (typeof s === "function") {
            this.paramsGenerator_ = s;
        }
        this.controller = new webview.WebviewController();
        this.__startUrl = this.createStorageLink('startUrl', 'https://mc.32768.top:8888', "startUrl");
        this.setInitiallyProvidedValue(p);
        this.finalizeConstruction();
    }
    setInitiallyProvidedValue(n: Index_Params) {
        if (n.controller !== undefined) {
            this.controller = n.controller;
        }
    }
    updateStateVars(m: Index_Params) {
    }
    purgeVariableDependenciesOnElmtId(l) {
        this.__startUrl.purgeDependencyOnElmtId(l);
    }
    aboutToBeDeleted() {
        this.__startUrl.aboutToBeDeleted();
        SubscriberManager.Get().delete(this.id__());
        this.aboutToBeDeletedInternal();
    }
    private controller: webview.WebviewController;
    private __startUrl: ObservedPropertyAbstractPU<string>;
    get startUrl() {
        return this.__startUrl.get();
    }
    set startUrl(k: string) {
        this.__startUrl.set(k);
    }
    initialRender() {
        this.observeComponentCreation2((i, j) => {
            Column.create();
            Column.width('100%');
            Column.height('100%');
        }, Column);
        this.observeComponentCreation2((g, h) => {
            Web.create({ src: this.startUrl, controller: this.controller });
            Web.domStorageAccess(true);
            Web.javaScriptAccess(true);
            Web.mixedMode(MixedMode.All);
            Web.overviewModeAccess(true);
            Web.fileAccess(false);
            Web.width('100%');
            Web.height('100%');
        }, Web);
        Column.pop();
    }
    rerender() {
        this.updateDirtyElements();
    }
    static getEntryName(): string {
        return "Index";
    }
}
registerNamedRoute(() => new Index(undefined, {}), "", { bundleName: "top.32768.chat", moduleName: "entry", pagePath: "pages/Index", pageFullPath: "entry/src/main/ets/pages/Index", integratedHsp: "false", moduleType: "followWithHap" });
