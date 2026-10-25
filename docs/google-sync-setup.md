# Google Tasks 同期のセットアップ

## 実装範囲

Phase 0〜1として、家事PlannerからGoogle Tasksへの一方向同期を実装しています。Google Tasks上の完了状態はアプリに取り込まず、アプリで完了した家事は対応するGoogle Taskを完了状態にします。Calendar API、Calendar同期、家族間・複数端末同期は対象外です。

同期対象は有効な家事の今日以降の予定と期限超過予定です。Google Tasksに `家事Planner` というTask Listを使い、schedule entry IDとGoogle Task IDを端末内SQLiteで対応づけます。アプリから消えた未完了Taskは次回同期で削除し、完了済みTaskは履歴として残します。

GoogleのTasks scope (`https://www.googleapis.com/auth/tasks`) は広い範囲のTasksデータにアクセスできます。設定画面で同期する家事名と予定日を送信すること、接続解除後も既存Google Tasksを残すことを案内します。

## OAuth方式とバックグラウンド制約

このアプリはサーバーを持たないため、Google公式のiOS/Androidネイティブ認証SDKでユーザー認証とaccess tokenの更新を行います。アプリ独自のSecureStoreやSQLiteへOAuth tokenを保存せず、Google SDKの資格情報管理を使います。offline access / server auth codeは要求しません。iOSではアプリ再起動後にSDKのサイレント復元を試み、AndroidではSDKに保存されたセッションを使います。自動同期から対話的なログイン画面は開きません。

Expo BackgroundTaskはWorkManager (Android) とBGTaskScheduler (iOS) を使います。指定値は60分の最小間隔で、実行時刻はOSが決めます。実行間隔、iOSでのオフライン更新、アプリを明示終了した後の実行は保証しません。起動時・アプリ復帰時にも期限を確認し、前面同期を試みます。

GoogleのモバイルSDKとExpoのバックグラウンド制約を確認する資料:

- [Expo Google authentication](https://docs.expo.dev/guides/google-authentication/)
- [Expo SDK 58 BackgroundTask](https://docs.expo.dev/versions/v58.0.0/sdk/background-task/)
- [Google Sign-In iOS API access](https://developers.google.com/identity/sign-in/ios/api-access)
- [Google Sign-In iOS offline access](https://developers.google.com/identity/sign-in/ios/offline-access)
- [react-native-nitro-google-signin](https://github.com/react-native-nitro-google-sign-in/google-signin)

## Google Cloud Console

1. Google Cloud projectを作成または選びます。
2. Google Tasks APIを有効にします。
3. OAuth consent screenを設定し、開発中はアプリをTestingにして利用するGoogleアカウントをtest usersに加えます。公開・検証要件はGoogle Cloud Consoleの表示に従ってください。
4. Web application OAuth client IDを作成します。ネイティブSDKの `webClientId` として使います。
5. iOS OAuth client IDを作成します。Bundle IDは `jp.jphacks.tkb2633` です。iOS clientのReversed client IDも控えます。
6. Android OAuth clientを作成し、package name `jp.jphacks.tkb2633` と、実際に使う開発・配布署名鍵のSHA-1 fingerprintを登録します。EAS credentialsを使う場合は `npx eas-cli@latest credentials -p android` で署名情報を確認してください。

OAuth client IDは公開識別子であり、アプリへ設定できます。client secret、access token、refresh tokenはこのアプリへ追加しないでください。値はGoogleのコンソールが発行したものだけを使い、推測・仮生成しません。

## ローカル開発

`.env.example` を `.env.local` にコピーし、Google Cloud Consoleで発行されたWebとiOSのclient IDを入れます。`.env.local` はGitに含めないでください。

```text
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<Web client ID>
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<iOS client ID>
```

`app.config.js` はiOS client IDからReversed client IDを生成し、両方のclient IDが揃った場合にだけGoogle Sign-In config pluginを有効にします。既存のOAuth画面と同じ環境変数名なので同一の `.env.local` を利用できます。以前の `GOOGLE_WEB_CLIENT_ID` / `GOOGLE_IOS_CLIENT_ID` / `GOOGLE_IOS_REVERSED_CLIENT_ID` も互換入力として利用できます。値が未設定でもアプリ設定とテストは読み込めますが、設定画面の「Googleと接続」は無効のままです。

値を設定した後はネイティブ開発ビルドを再生成します。`ios/` と `android/` は生成物なので直接編集しません。
Googleからアプリへ戻るiOS URLは、config pluginでGoogle Sign-In SDKへ転送します。Expo SDK 58のscene lifecycleからAppDelegateへの転送を利用します。

```bash
npx expo run:ios
npx expo run:android
```

EAS development buildでは同じ変数をビルド環境に設定してから実行します。

```bash
npx eas-cli@latest build --profile development --platform ios
npx eas-cli@latest build --profile development --platform android
```

OAuth client IDを設定せずに構成を確認する場合:

```bash
npx expo config --type public
```

Google Sign-Inはネイティブmoduleを使います。Expo Goではなくdevelopment buildで実機または対応シミュレータを使ってください。

## 同期動作と状態

- 成功後24時間経過すると次の通常同期対象になります。
- 一時通信障害・timeout・5xxは約1時間後に再試行します。
- HTTP 429は`Retry-After`を尊重し、1時間より早く再試行しません。
- 401やGoogle SDKのサインイン要求は再認証状態になります。
- 手動同期は24時間間隔を無視します。
- Google Tasksへのリクエストに期限20秒を設定します。
- 同期状態とTask ID対応表はSQLiteに保存します。Google tokenはSQLiteへ保存しません。
- BackgroundTaskが登録できない場合も、接続直後・起動時・アプリ復帰時・手動操作の前面同期は利用できます。

## 実機テスト

1. `.env.local` に正しいOAuth client IDを設定してdevelopment buildを作ります。
2. Google Tasksを使うtest userでアプリから接続し、Google Tasks scopeを許可します。
3. 設定画面から「今すぐ同期」を実行し、Google Tasksの `家事Planner` listに今日以降の予定が作られることを確認します。
4. 家事名・予定日変更、アプリ側完了、ローカル家事無効化・削除、Google側Task削除をそれぞれ試し、同じTaskの更新・完了・cleanup・再作成を確認します。
5. Google側だけでTaskを完了し、アプリへ完了が取り込まれず、Taskが未完了へ戻らないことを確認します。
6. 接続解除し、ローカルbackground taskが停止し、Google上の既存Taskが残ることを確認します。

2026-10-25にGoogle Cloud project `housework-planner-tkb2633` でTasks APIを有効化し、外部・テスト中のOAuth同意画面、Web・iOS・Android開発用の各クライアント、所有者アカウントのテストユーザー登録、Tasks scopeを設定しました。Web・iOSの公開client IDは、この端末のGit管理外の `.env.local` に設定済みです。

Android開発用クライアントは、既存のローカルdebug署名に対応しています。EASやGoogle Playの配布署名を使う場合は、その署名に対応する別のAndroidクライアント登録が必要です。

2026-10-25、専用のiOS Simulatorのdevelopment buildで、所有者本人によるGoogleログインとTasks権限許可後に初回同期が成功しました。12:20 JSTの端末SQLiteを読み取り専用で確認し、同期状態 `idle`、同期有効、Task List ID保存済み、エラーなし、1種類の家事の予定180件にそれぞれ異なるGoogle Task IDが保存されていることを確認しました。対象日付は2026-10-26〜2027-04-23です。

これは初回同期の確認結果です。Google Tasks / Calendarの表示、再同期時の重複なし、予定日変更、アプリ側完了、再起動後の接続維持については、操作後の結果を確認してから別途記録します。iOS SimulatorではBackgroundTaskの実動は未検証です。
