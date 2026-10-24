# アプリの構成

## 基本方針

天気・AI・家族間同期など外部機能を使う場面を除き、家事データとスケジュールは端末内で扱います。ローカルSQLiteを保存先とし、外部サービスは機能ごとのポートを介して接続します。

## できている土台

- `src/platform/storage/migrations.ts`: 世帯、メンバー、家事、担当、依存関係、予定、完了履歴、曜日ごとのゴミ収集日、同期待ち変更の初期テーブル。
- `src/features/waste/weekly-scheduler.ts`: 曜日設定を指定期間の収集日に展開。
- `src/platform/notifications/expo-local-notification-gateway.ts`: OSの端末内通知を予約・取り消しする汎用アダプター。通知時刻や文面、完了操作は呼び出し側から渡す。
- `src/platform/widgets/`: iOSとAndroidそれぞれの「次の家事」ウィジェット登録コンポーネントと、アプリからスナップショットを更新するゲートウェイ。
- `src/features/weather/contracts.ts`: 天気取得とスケジュール調整のポート。調整は `WEATHER_ADJUSTMENTS_ENABLED = false` で無効。
- `src/features/appliance-care/contracts.ts`: 公式資料に基づく家電お手入れ情報の解析結果を受け取る契約。AIや資料取得先は未接続。
- `src/features/waste/contracts.ts`: 例外データの意味や適用順を決めずに、後から例外処理を接続する契約。
- `src/features/sync/contracts.ts`: 家族間同期用の変更キュー契約。同期サーバーやアカウント方式は未選定。
- `src/domain/scheduling/contracts.ts`: 家事予定の生成・未完了予定の再調整エンジン契約。エンジン本体は未実装。

## 未決定の機能を追加する場所

### 天気

天気API、場所の取得方法、天候条件、洗濯を含む家事への適用規則を選んでから、`WeatherForecastProvider` と `WeatherAdjustmentPolicy` の実装を追加します。現状、スケジュールの日付は天気で変わりません。

### ゴミ収集日の例外

通常の曜日設定は動かせます。祝日などの例外の種類・優先順位は決めていないため、`WasteExceptionSource` と `WasteExceptionPolicy` の実装および保存形式は未追加です。

### 通知

端末内で日時指定の通知を予約・取り消しできます。通知権限を要求するタイミング、表示文、通知アクション、再通知の規則はまだ接続していません。リモート通知サービスも使っていません。

### ウィジェット

`NextChoreWidget` をiOSとAndroidに登録し、同じスナップショット契約で更新する枠を用意しました。今の表示は空状態の仮表示です。データ更新の時期、操作、表示サイズなどは今後決定します。

### AI

`ApplianceCareAnalyzer` の契約だけを置いています。AI API、公式資料の検索・取得、解析、ユーザー確認画面は実装していません。

## オフラインと家族共有

各端末の家事管理をSQLiteで完結させます。世帯・担当者のデータ形式と同期待ち変更のテーブルは用意しましたが、端末間で家族が同じ情報を見るには同期先が必要です。`HouseholdSyncGateway` を通す形にし、同期先が未設定の今は他端末へ変更を送信しません。

## ネイティブ開発

Expo Widgetsはネイティブ拡張を含むため、ウィジェットを確認するときはiOS・Androidの開発ビルドを作成します。Expo Goではウィジェットを実行できません。
