import { webview } from '@kit.ArkWeb';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @StorageLink('startUrl') startUrl: string = 'https://mc.32768.top:8888';

  build() {
    Column() {
      Web({ src: this.startUrl, controller: this.controller })
        .domStorageAccess(true)
        .javaScriptAccess(true)
        .mixedMode(MixedMode.All)
        .overviewModeAccess(true)
        .fileAccess(false)
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
  }
}
