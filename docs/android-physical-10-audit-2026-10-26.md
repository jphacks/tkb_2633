# Android 10実機での確認と修正

Sony I4293（Android 10 / API 29、arm64-v8a）へLiFlowをインストールして検査した。APKのminSdkは24、targetSdkは36。Google Play開発者サービスは26.41.31。1080×2520、density 420、端末の文字倍率1.15とダーク設定を維持した。

## 修正した問題

### 白い画面でシステム表示が読めない

Release版で時計・電池と、Androidの戻る／ホーム操作が白く薄く表示された。画面の色に対して、システムバーの配色が指定されていなかった。

LiFlowの画面は白い配色なので、native appearanceをlightに揃えた。これだけでは改善しなかったため、SDK 58のStatusBarとNavigationBarで暗いアイコンを明示する。NavigationBarはAndroidだけに配置し、iOSにはAndroid用の操作を実行しない。起動時の設定も同じExpo config pluginへ揃える。

生成されたAndroidの`windowLightStatusBar` / `windowLightNavigationBar`はともにtrue。Release版を更新して、実際の時計・電池・戻る／ホーム操作が読めることを確認した。[Androidのホーム](qa-assets/android-physical-10-2026-10-26/android-release-home.png)、[iPhoneのホーム](qa-assets/android-physical-10-2026-10-26/ios-release-home.png)。

公式仕様：[SDK 58 StatusBar](https://docs.expo.dev/versions/v58.0.0/sdk/status-bar/)、[SDK 58 NavigationBar](https://docs.expo.dev/versions/v58.0.0/sdk/navigation-bar/)。

### 通信失敗時に内部エラーが表示される

端末が未接続だったとき、地域検索にJavaのDNSエラーがそのまま表示された。地域検索のUI境界で日本語の案内へ変換した。入力変更による再試行、古い検索の中断、検索結果の並べ替えは維持する。

AndroidのDNSエラー、iOSの通信エラー、上流の診断メッセージを使った回帰テストは修正前に3件失敗し、修正後に成功した。入力を変えて復旧する経路と、古い検索結果を採用しない経路も検査する。

修正版のRelease実機でもWi-Fiを短時間切り、日本語の再入力案内が表示され、Javaのエラーが表示されないことを確認した。Wi-Fiを元へ戻した後は地域候補を再取得できた。

## 実機で確認した範囲

| 対象 | 確認内容 |
| --- | --- |
| 初期設定 | 全20家事を無効・前回不明で完了し、家事0件のホームへ進む。SQLiteでもunknown 20件を確認。 |
| ゴミ収集 | 初期設定で毎週月曜のペットボトルを登録。ホームで非表示にし、カレンダーの四角から戻す。 |
| 天気検索 | 未接続時の失敗と、接続後のYokohama検索、日本語候補「横浜市, 神奈川県」の確定。 |
| 家事の設定 | 無効だったフローリングを有効化し、周期7→17日を自動保存。更新・再起動後も17日を保持。 |
| 有効／無効の切替 | 無効化でホームから消え、再有効化と7日への変更で1枚だけ戻る。 |
| 完了／取消 | ホームの四角から完了し、もう一度押して未完了へ戻る。カレンダーでも当日の未完了1件を確認。 |
| 数値入力 | 周期17と実施幅±2の配置、Androidの数値入力とキーボードを閉じた後の保存。 |
| Release起動 | 開発サーバー停止中の起動と、APK上書き後の家事・ゴミ・Google接続状態の保持。 |
| Google | 所有者がアカウントを選択。Release版でTasks同期成功、Calendar追加権限と実際の予定時間帯取得成功。 |
| 家電AI | 開発ビルドからUSB経由で実APIを実行。Dyson V12 Detect Slim（SV20）の10項目・78手順を保存。周期あり1件を予定登録し、周期なし9件も保持。Releaseへ更新した後も詳細を表示。 |
| iPhone更新 | 同じ変更の署名付きReleaseをインストール。更新前後のSQLite全17テーブルが一致。起動とXCTestの表示確認1件が成功。 |

[17日の自動保存](qa-assets/android-physical-10-2026-10-26/android-autosave-17.png)、[Releaseへ更新後の保存した家電](qa-assets/android-physical-10-2026-10-26/android-saved-appliance.png)を記録した。

Androidの[アプリ情報に表示されたLiFlowと丸いアイコン](qa-assets/android-physical-10-2026-10-26/android-native-icon.png)も確認した。白い図形は丸い表示範囲に収まっている。

## 確認範囲の限界

Googleを接続した時点では全家事が無効で、Tasksの同期対象は0件だった。Calendarの取得後に連携と自動同期を停止し、以後の家事・家電操作はローカルで検査した。実機でのTasksの双方向変更、heavy家事の移動、同じTask IDのdue更新までを通したPhase 3 E2Eとは扱わない。そのシナリオの実アカウント確認は[Android Emulatorの記録](android-google-e2e-2026-10-26.md)を参照する。

家電AIはUSBでMacの開発用HTTP APIへ接続した開発ビルドで確認した。同じHTTP接続はAndroid Release版で失敗した。Debug manifestだけがcleartextを許可しており、[Androidの通信仕様](https://developer.android.com/privacy-and-security/security-config#CleartextTrafficPermitted)とも整合する。Releaseの通信制限は緩めていない。USBなしで新規解析・再解析を使うには、到達可能なHTTPS APIを用意して`EXPO_PUBLIC_APPLIANCE_CARE_API_URL`へ設定する必要がある。保存済みの内容はReleaseで読める。

OSへ長時間任せるBackgroundTask、Doze・電池最適化後の同期、通知の指定時刻での実機配信、実機での天気による洗濯移動は今回未検証。iPhone実機のGoogle連携と家電APIも従来どおり未検証とする。

## 回帰確認

- Lint・TypeScript型検査：PASS。
- iOS条件・Android条件：各683テストPASS。既存の44 feature contractを保持。
- Expo Doctor：20/20 PASS。
- Android arm64のDebug / Releaseと、iPhone向け署名付きReleaseを再ビルド。
- アプリのpackage、bundle ID、URL scheme、SQLite保存先、Google OAuth識別子を保持。

集計値は[verification.json](qa-assets/android-physical-10-2026-10-26/verification.json)に保存した。生のDB、端末ID、アカウント情報、認証情報、個人のホーム画面は公開しない。
