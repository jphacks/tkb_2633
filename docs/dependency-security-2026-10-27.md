# 依存関係の脆弱性対策（2026-10-27）

Expo SDK 58を維持し、npm auditのhigh 6件を構成していた2種類の問題を公式修正版で解消した。最終構成で全依存・開発依存を含むnpm auditは0件となった。アプリの共有暗号、データ形式、ネイティブモジュールは変更していない。

| 原因 | 対応 | 結果 |
| --- | --- | --- |
| Zodの過大なコレクションの検証負荷（[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)） | `3.25.76`から公式修正版`4.6.7`へ固定 | この指摘を解消 |
| node-forgeのRSA署名の構造検証不足（[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)） | 公式修正版`1.4.1`へ固定。入れ子の余分な要素と非標準のDigestInfoを拒否 | この問題と依存元へ波及していた指摘を解消 |

当初の照合時はnode-forgeの最新版が1.4.0だったが、再照合で[公式1.4.1](https://github.com/digitalbazaar/forge/blob/v1.4.1/CHANGELOG.md)の公開を確認した。npmの公開者、公式Gitタグ、gitHeadと配布物のソースを照合して公式版へ切り替えた。最終実装にはnode-forgeのローカル補修や未マージPRのコードは含めない。

## 互換性

`package.json`のoverridesとlockfileで解決先を固定する。lockfileの変更はnode-forgeとZodの2パッケージだけで、Expo 58.0.19、CLI 58.1.15およびネイティブのバージョンは維持した。node-forge 1.4.1は依存元の`^1.4.0`に適合する。

ZodはExpo CLIの指定する旧メジャーからの変更になるため、実物のプラグイン・結果・MCPコマンドのスキーマを検査した。正常データの保持、不正な型と未知の引数の拒否、readonly、JSON Schema変換を確認した。React Hooksとzod-validation-errorも同じ修正版へ解決し、脆弱な旧コピーを残さない。

Zodの上限付き配列・Set・Mapは、同期・非同期の双方で要素の検証前に過大な入力を拒否する。上限を設定しない入力をあらゆる用途で安全に扱えるという意味ではない。

node-forgeは正規のDER表現を要求する。正常なSHA-256のNULL有無の表現を維持し、余分な要素、内容のあるNULL、非最短の長さ表現を拒否する。Expoの証明書生成・検証・manifest署名とNode標準cryptoによる照合も検査した。利用者の署名資格情報は使わず、テスト用の鍵をメモリ内で生成する。

## 検証と継続チェック

- 追加11ケースで依存解決、Zodの早期拒否、Expo CLIの互換性、不正署名の拒否、正常署名を検査する。
- 隔離した未修正1.4.0では上流の公開偽造署名が受理され、公式1.4.1では同じ署名が拒否されることを確認した。再現データには公開鍵と署名のみを含める。
- クリーンなnpm ci後にも追加11ケースとnpm auditの0件を確認した。依存の再インストール時にnode-forgeを加工するスクリプトは不要。
- 既存77件の機能契約を維持して合計79件へ拡張した。既存機能のテストを削除・緩和しない。
- 最終構成でiOS・Android各873/873テスト、lint、型検査、Expo Doctor20/20、Firestore結合テスト20件を通過した。iOS・Android向け本番バンドル生成も成功した。
- 公式v1.4.1のRSA単体テストを隔離したコピーで実行し、133件PASS・4件pendingを確認した。上流の条件付きスキップは成功件数へ含めない。
- CIにnpm audit --audit-level=highを追加し、今後high/criticalが発見された場合も成功扱いにしない。

今回の変更は開発ツールのJavaScript依存のみで、両端末のデータ初期化や認証のやり直しは行わない。npm auditの0件はこの時点の既知advisoryとの照合結果であり、独立した外部セキュリティ監査を済ませたという意味ではない。OSによる自然なBackgroundTask実行など、共有機能の既存の公開条件も変更しない。
