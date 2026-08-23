import UIAbility from "@ohos:app.ability.UIAbility";
import type Want from "@ohos:app.ability.Want";
import hilog from "@ohos:hilog";
import type window from "@ohos:window";
const TAG: string = 'SecureChat.EntryAbility';
const DOMAIN: number = 0x0000;
export default class EntryAbility extends UIAbility {
    onCreate(want: Want): void {
        hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onCreate');
        // Intercept launcher parameters; fall back to the SecureChat web URL.
        const params = want?.parameters ?? {};
        const launcherParam = (params as Record<string, Object>)['launcherParam'];
        const startUrl: string = (launcherParam && `${launcherParam}`) || 'https://mc.32768.top:8888';
        AppStorage.setOrCreate('startUrl', startUrl);
    }
    onDestroy(): void {
        hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onDestroy');
    }
    onWindowStageCreate(windowStage: window.WindowStage): void {
        hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageCreate');
        windowStage.loadContent('pages/Index', (err) => {
            if (err.code) {
                hilog.error(DOMAIN, TAG, 'Failed to load the content. Cause: %{public}s', JSON.stringify(err) ?? '');
                return;
            }
            hilog.info(DOMAIN, TAG, '%{public}s', 'Succeeded in loading the content.');
        });
    }
    onWindowStageDestroy(): void {
        hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageDestroy');
    }
    onForeground(): void {
        hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onForeground');
    }
    onBackground(): void {
        hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onBackground');
    }
}
