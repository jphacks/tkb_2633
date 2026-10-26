# LiFlowのアプリ名・アイコンと実機確認

iOS・Androidの表示名をLiFlowへ変更した。アイコンは両OSとも同じ[PNG](../assets/images/liflow-icon.png)を使う。起動時の画像も同じものに揃える。

Bundle ID / Android package (`jp.jphacks.tkb2633`) とURL scheme (`houseworkplanner`)は保持する。名前変更による別アプリ化や、既存のSQLite・Google認証・Task紐付けの喪失を避ける。

## Androidの丸いマスク

Androidの108dp adaptive layerに各辺18dpのinsetを設け、共有画像を72dpの表示範囲へ合わせる。白い図形の外接直径は約56.9dpで、66dpの安全範囲に入る。丸いマスクやroundIconも同じリソースを参照する。旧Android向けの通常アイコンも同じ画像を使う。

[Androidの実際のアプリ一覧](qa-assets/liflow-branding-2026-10-26/android-circular-launcher.png)で、LiFlowの名前と丸枠内に収まる図形を目視した。

## iOSの署名と通知

`APPLE_TEAM_ID`は任意のローカルビルド設定として読み取り、アプリとウィジェット両ターゲットへ適用する。実際のTeam IDや証明書はリポジトリに保存しない。

このアプリの通知は端末で予定するローカル通知であり、APNsのトークン取得やリモート配信は実装されていない。SDK 58の公式`enableRemoteNotifications: false`を使用して不要なAPNs entitlementを追加しないようにした。ローカル通知・App Groups・ウィジェットは保持する。既存の生成済みプロジェクトから不要な権限を除くには、設定変更後にiOSをclean prebuildする。

公式仕様: [Expo notifications SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/notifications/)、[ios.appleTeamId](https://docs.expo.dev/versions/v58.0.0/config/app/#appleteamid)、[Android adaptive icons](https://developer.android.com/develop/ui/views/launch/icon_design_adaptive)。

## 画像の生成方法

利用者の参考画像を入力し、組み込みimagegenツールで生成した。図形の直接切り抜きへ切り替えず、画像生成を続けるという利用者の選択に従った。生成されたPNGをそのままアプリ資産へコピーし、OS向けのサイズ生成とマスク配置はExpoのビルド処理で行う。

最終生成プロンプト:

```text
Use case: precise-object-edit, logo-brand. Create the final LiFlow application icon from the attached reference. Faithfully preserve the EXACT white emblem composition: top diagonal outlined spatula with four short slots and a diagonal handle ending in a round hand; tilted checklist with three bars and three round dots at lower left, held by a round hand; round human head and raised right arm with angular body at lower right. Keep the same orientations, proportions, recognizable outlines and relative positions. Clean flat vector-like solid white #FFFFFF artwork, uniform smooth outlines, no speckles, no texture, no dirt, no gradients, no shadow, no added elements, no text. Replace the beige outer margin and the blue rounded rectangle with ONE perfectly uniform full-bleed blue background RGB(101,166,213), hex #65A6D5, reaching every corner of a square 1024x1024 PNG. Do not draw rounded corners: the operating system supplies the icon mask. Uniformly shrink and center the entire original white emblem as one group, with generous blue space surrounding it: all white pixels should fit comfortably inside a centered circle of diameter 800px, so a circular mask cannot cut the emblem. Preserve the original geometry; only normalize clean flat edges and adjust the uniform scale and position. The artwork must be perfectly clean and fully opaque, not distressed and not textured.
```

生成結果は1254×1254の不透明PNG。プロンプトのサイズ・色指定から微差があるため、実ファイルの白い図形の範囲を走査して安全域を検証し、背景設定には実際の画像の代表色`#5AA2D7`を用いた。

## iPhone 12で確認した結果

接続中のiPhone 12（iOS 26.7.1）へ、署名付きRelease版をインストールした。開発サーバーを止めた状態で起動し、次を確認した。

- 初期設定で前回の時期を不明にし、19件を無効・フローリング1件だけ有効にしてホームへ進む。
- 無効だったトイレの家事を有効にし、周期を7日から17日へ変更すると自動保存される。
- Release版への更新後も、有効状態と17日の設定が保持される。
- ホームの四角から完了し、もう一度押して未完了へ戻せる。
- 周期7日・無効へ戻して画面を閉じても保存される。
- SQLiteの整合性が正常で、20件の組み込み家事と初期設定・通知許可が保持される。

[Release版のホーム](qa-assets/liflow-branding-2026-10-26/ios-physical-release-home.png)、[更新後も保持された自動保存値](qa-assets/liflow-branding-2026-10-26/ios-physical-autosave-preserved.png)を記録した。初期設定の家事名はアクセシビリティ上でカードのボタン名へまとまるため、検査ではボタンを参照する。

[実機でのアイコン表示](qa-assets/liflow-branding-2026-10-26/ios-physical-launcher-icon.png)も確認した。個人のホーム画面全体を公開せず、XCTestが取得したLiFlowアイコン要素だけを掲載している。iOSによる角丸・光沢と、Androidによる丸いマスクはOSが適用する。

[実行したRelease版の操作シナリオ](qa-assets/liflow-branding-2026-10-26/PhysicalUITests.swift)は記録用であり、認証済み実機を変更するCIには組み込まない。周期保持のシナリオは、初期設定後にトイレを有効・17日に保存した状態を前提に個別実行し、最後に7日・無効へ戻す。アイコンのシナリオはホーム画面で個別実行する。

この実機確認の対象は、表示名・アイコン・初期設定・個別設定の保存・ローカルでの完了と取り消し。Google Tasks / Calendarの実アカウントE2Eと家電AIは従来のiOS Simulator・Android Emulatorでの記録を参照し、今回のiPhone実機では未検証とする。OSへ長時間任せるBackgroundTaskと、通知の指定時刻での実機配信も未検証。

今回使用したPersonal Teamの開発用プロビジョニングは、2026年11月2日20:50頃（日本時間）まで有効。その後も実機で使うには新しいプロファイルで再ビルド・再インストールする。Apple Accountや証明書の秘密鍵はリポジトリに含めない。

## 回帰確認

- iOS・Android両条件で676テスト、44のfeature contractがPASS。
- Lint・型検査・Expo Doctor（20/20）がPASS。
- Android nativeの再生成・assembleDebugと、iPhone向けDebug / Releaseの署名付きビルドが成功。
- Androidの検査用端末は更新前後で7テーブル、通常の端末は18テーブルが完全一致。通常端末のGoogle Task紐付け575件と接続状態も保持。
- アプリの名前・画像・署名設定のみを変更し、既存のGoogle識別子とSQLiteの保存先は保持。

集計結果は[検証記録](qa-assets/liflow-branding-2026-10-26/verification.json)に保存した。生のDB、実アカウント情報、端末ID、署名資格情報、ホーム画面全体は公開していない。
