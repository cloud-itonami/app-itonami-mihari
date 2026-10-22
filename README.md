# app-itonami-mihari

**mihari（見張り）は Sentry 互換のエラー見張り dapp。**
Sentry の envelope／event JSON を取り込み、issue にまとめ、トリアージして、Sentry と同じ形の JSON と envelope で書き出す。
すべて利用者のブラウザの中で動き、入力は送信されない（外部リクエストはゼロ）。

公開先は app.itonami.cloud（`network-awai/cloud-itonami` の `sites.edn`、`app` org）。
公開の配線はそちらの repo の作業で、この repo が持つのは中身と公開物の宣言（`site/site.edn`）。
追跡は Linear JUN-286、dapp の形は JUN-116（1 repo = 1 スライス）に従う。

> Sentry は Functional Software, Inc. の商標です。mihari はデータ形式の互換を名乗るだけで、同社との提携や同一性を主張しません。

## 何があって、何が動くか

| 層 | ファイル | 状態 |
|---|---|---|
| 判断コア guest | `aiueos/mihari_core.cljk`（ns `mihari.guest`、`:effects #{}`） | **実装済み・実測**: amu check / test 24/24（8 tests × jvm-kir/js/wasm） |
| wasm 産物 | `aiueos/mihari_core.wasm`（5,737 bytes）+ provenance / publication | **実測**: 公開する .wasm を amu の typed ホストで読み、parity 表 47/47 行 |
| アプリ記述子 | `aiueos/mihari.edn`（`:aiueos/kind :app`） | 記述のみ。aiueos の session/grant への配線は**未実装** |
| adapter | `src/mihari/core.cljk` — guest と同名・同結果の関数 + issue ストア | **実装済み・実測**（kbb） |
| 取り込み | `src/mihari/ingest.cljk` — envelope（`length` は UTF-8 バイトで切る）／event JSON／API `/events/` 形 | **実装済み・実測**（kbb） |
| 書き出し | `src/mihari/export.cljk` — issue 一覧・events を Sentry API と同じキーで、envelope は取り込み直せる形で | **実装済み・実測**（kbb、ブラウザ） |
| 画面 | `src/mihari/view.cljk`（純 hiccup）+ `site/app.cljk`（Re-frame/Reagent、scittle） | **実測**: ローカル配信で取り込み → トリアージ → regression → 再読込で永続 → 書き出し → 消去 |
| 公開物の宣言 | `site/site.edn`、`site/mihari/page.cljk`、`site/vendor/`（+ `PROVENANCE.edn`） | 宣言済み。app.itonami.cloud への公開は cloud-itonami 側の作業 |
| 分散状態 | ADR 0005 の `mon` / `ito` / `nuno` | **未実装**（設計のみ。docs/aiueos-dapp.md） |
| 本家 Sentry API 直結 | — | **未実装・ブロック中**（`kotoba-client-runtime.js` が無い） |

詳細な実測と「動かない」ものは [`docs/aiueos-dapp.md`](docs/aiueos-dapp.md)。

## 互換の範囲

**データ形式の互換**であって、Sentry 本家の内部アルゴリズムの再現ではない。

- 受ける形:
  - SDK が `/api/{project}/envelope/` に送る **envelope**
    - item header の `length` があればバイト数で区切り、無ければ改行で区切る。
    - `event` と `transaction` だけ取り込み、`attachment`・`session` などは種類ごとに数えて報告する。
  - **event JSON**（1 件または配列）
  - Sentry API の **`/events/` 応答**（`eventID`／`dateCreated`／`tags` 配列）
- 語彙:
  - level は `debug` / `info` / `warning` / `error` / `fatal`。
  - status は `unresolved` / `resolved` / `ignored`（kotoba-lang/com-sentry と同じ enum）。
  - priority は `low` / `medium` / `high`。
- 書き出す形:
  - issue 一覧は `GET /api/0/projects/{org}/{project}/issues/` の要素と同じキー。`count` は Sentry と同じく文字列、`userCount` は数。
  - resolved に event が届いた issue は `substatus: "regressed"`。
  - events は `GET /api/0/issues/{id}/events/` の要素と同じキー。
  - envelope は item ごとに `length` 付きで出す。取り込み直すと同じ issue に戻る（テストで確認）。

### mihari の規則（Sentry と同じだとは主張しない）

- **グルーピング**: 次の優先順で決めた文字列を `project` と合わせて `fingerprint` にかけ、issue id にする。
  1. event に `fingerprint` 配列があればそれ（`{{ default }}` は既定の文字列に置き換える）。
  2. 無ければ最後の例外の `type: value` と最後の frame。
  3. それも無ければ message。
- **fingerprint**: UTF-16 code unit の多項式ハッシュ。`h = (h*31 + c) mod 2147483647`、初期値 7。
- **status 遷移**:
  - resolve / ignore / unresolve はその状態に移る。
  - resolved の issue に event が届いたら unresolved に戻し、regression として印を付ける。
  - ignored の issue は event では起きない。
- **priority**:

  | level | 条件 | priority |
  |---|---|---|
  | fatal | — | high |
  | error | 利用者 10 人以上、または event 100 件以上 | high |
  | error | それ以外 | medium |
  | warning | 利用者 10 人以上 | medium |
  | warning | それ以外 | low |
  | info／debug | — | low |
- **shortId**: `<PROJECT>-<n>`（project ごとの連番。project 省略時は `MIHARI-<n>`）。

これらの判定は guest（`aiueos/mihari_core.cljk`）が正本です。adapter・guest の test-*・wasm 産物の 3 つを、同じ表（`test/fixtures/parity.edn`）で照合しています。

## プライバシーの規則

取り込む時点で次のものを捨てる。捨てたものは保存されず、書き出しにも出ない（テストで確認）。

- `user.ip_address`
- `request.headers`、`request.cookies`、`request.env`（`REMOTE_ADDR` など）
- 名前に IP を含む tag（`client_ip`、`user.ip` など）
- `user.email`
  - email しか無い利用者は、email の fingerprint を `id` にして数える。email 自体は残さない。
  - IP しか無い利用者は数えない。

データは利用者のブラウザの `localStorage`（キー `itonami.mihari.v1`）にだけ置く。画面の「すべて消去」で消える。fetch も XHR も使わない。

## 動かし方

west レイアウト（`<root>/cloud-itonami/app-itonami-mihari` と `<root>/kotoba-lang/*`）を前提にする。

```sh
npm test            # kbb: parity 表 + adapter + 取り込み/書き出し + view（18 tests）
npm run test:guest  # amu test: guest の test-* を jvm-kir / js / wasm で
npm run test:wasm   # 公開する .wasm を amu の typed ホストで読み、parity 表を全行
npm run build:guest # amu compile → aiueos/mihari_core.wasm + sidecar
npm run preview     # site/site.edn どおりに out/preview/ を組む（静的サーバで開く）
```

## ライセンス

AGPL-3.0-or-later。`site/vendor/` の同梱物は各ライセンス（scittle: EPL-1.0、React: MIT）。出所と digest は `site/vendor/PROVENANCE.edn`。
