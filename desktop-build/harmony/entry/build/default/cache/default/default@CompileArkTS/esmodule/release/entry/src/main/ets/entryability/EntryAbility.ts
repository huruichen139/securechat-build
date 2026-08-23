import UIAbility from "@ohos:app.ability.UIAbility";
import type Want from "@ohos:app.ability.Want";
import hilog from "@ohos:hilog";
import type window from "@ohos:window";
const TAG: string = 'SecureChat.EntryAbility';
const DOMAIN: number = 0x0000;
export default class EntryAbility extends UIAbility {
    onCreate(c: Want): void {
        hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onCreate');
        const d = c?.parameters ?? {};
        const e = (d as Record<string, Object>)['launcherParam'];
        const f: string = (e && `${e}`) || 'https://mc.32768.top:8888';
        AppStorage.setOrCreate('startUrl', f);
    }
    onDestroy(): void {
        hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onDestroy');
    }
    onWindowStageCreate(a: window.WindowStage): void {
        hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageCreate');
        a.loadContent('pages/Index', (b) => {
            if (b.code) {
                hilog.error(DOMAIN, TAG, 'Failed to load the content. Cause: %{public}s', JSON.stringify(b) ?? '');
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
