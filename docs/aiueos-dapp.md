# mihari エラー見張り dapp — aiueos 上の分散型設計

状態: 第 1 スライス実装（2026-10-22）。正本はこの文書。
追跡: Linear JUN-286（プログラムは JUN-116）。参照実装: `cloud-itonami/kaikei` の docs/aiueos-dapp.md。

## 目標

mihari を「サーバに状態を置かない Sentry 互換の dapp」として実現する。
エラー event は個人に結び付く情報を含みやすいので、**利用者の端末から出さない**ことを最初の要件にする。

- 実行面は aiueos（kotoba-lang/aiueos）。
- 中央 DB は持たない。
- 本家 Sentry の代わりに受信サーバを立てることもしない。
  - app origin は静的配信だけ（workspace AGENTS.md「Kotoba end-user apps run in the user's environment」）。

## 層構成

| 層 | 実体 | 状態 |
|---|---|---|
| 判断コア（guest） | `aiueos/mihari_core.cljk` — fingerprint / next-status / regression? / priority / level-at-least? / sampled? / max-level。`:effects #{}` の pure 計算 | **実装済み・実測**（下記） |
| アプリ記述子 | `aiueos/mihari.edn`（`examples/apps/notes.edn` 形、`:aiueos/kind :app`） | **記述済み**。aiueos session/grant への配線は未実装 |
| adapter | `src/mihari/core.cljk` — guest と同名・同結果 + issue ストア（純粋な値） | **実装済み・実測**（kbb） |
| 取り込み・書き出し | `src/mihari/ingest.cljk` / `export.cljk` | **実装済み・実測**（kbb + ブラウザ） |
| 画面 | `src/mihari/view.cljk` + `site/app.cljk`（Re-frame/Reagent on scittle） | **実測**（ローカル配信、下記） |
| agent 統合（MCP） | `bin/mihari-mcp`（stdio）+ `src/mihari/mcp.cljk` — `mihari_ingest_events` / `mihari_decide`。adapter を呼ぶ純関数で、状態を持たない | **実装済み・実測**（下記）。peer run では無効（itonami-agent 側の規則） |
| 状態 | `localStorage`（キー `itonami.mihari.v1`）、1 ブラウザに閉じる | 実装済み。分散は未実装 |
| 分散状態 | ADR 0005 の `mon` / `ito` / `nuno` | **未実装**（設計のみ、下記） |
| 本家 API 直結 | `kotoba.app.client-runtime.v1` ブローカー経由の operation ごとの同意 | **未実装・ブロック中**（下記） |

## 実測（2026-10-22、このスライスで実行したもの）

- `amu check aiueos/mihari_core.cljk` → `:ok true`, `:effects #{}`。export 16（関数 8 + test 8）。
- `amu test aiueos/mihari_core.cljk` → **24/24 passed**（test 8 本 × targets `[:jvm-kir :js :wasm]`）。
  - 期待値を 1 つ変えた変異版では 3 ターゲットとも FAIL することを確認した（テストが空振りしていない）。
- `amu compile aiueos/mihari_core.cljk --target wasm32-browser --output aiueos/mihari_core.wasm` で次の 3 つを得た。22 definitions。
  - `aiueos/mihari_core.wasm`: WebAssembly MVP module、5,737 bytes、sha256 `a4688fa4…9550`
  - `.provenance.edn`（`:source-sha256` は現在の .cljk と一致）
  - `.publication.edn`
  - 再コンパイルしても同じ sha256（決定的）。
- `node test/guest_parity.mjs` → **wasm parity 47/47 行**。
  - 公開する .wasm を publication sidecar の sha256 で照合してから実行した。
  - 実行ホストは amu の typed ホスト `kotoba-lang/amu/runtime/browser-host.mjs`（`instantiateKotoba`）。
  - vector 引数は `typedValues.vectorI64` で渡した。
- `npm test`（kbb）→ **18 tests, 184 assertions, 0 failures**。
  - 内訳: parity 表 47 行 / ストア / 取り込み / プライバシー / 書き出しと再取り込み / view。
  - priority の閾値を 1 つ変える変異と、IP を落とす処理を外す変異では FAIL することを確認した。
- ブラウザ（`npm run preview` を 127.0.0.1 の静的サーバで配信。Claude の built-in browser）:
  - **描画**: SSR の殻の上に Reagent がマウントした（`#app` に React root）。
  - **取り込み**:
    - サンプル 4 件から 3 issue ができた。
    - 貼り付けた event が resolved の issue に入り、unresolved に戻って `regressed` 表示になった。
    - `File` を `:mihari/read-file` effect に通した取り込みも動いた。
  - **永続化**:
    - resolve 後に再読込しても状態が残った。
    - localStorage に IP（`192.0.2.44`）は入っていなかった。
  - **書き出し**:
    - `issues.json` は `count` が文字列、`substatus: "regressed"` だった。
    - `events.envelope` は header + 5 event × 2 行の 11 行で、IP を含まなかった。
    - 中身はアンカーの click を差し替えて取り出し、実際のダウンロードはしていない。
  - **消去**: 「すべて消去」で 0 件になり、localStorage のキーも消えた。
  - **外部通信**: `performance.getEntriesByType('resource')` に同一オリジン以外は 0 件だった。

### agent 統合（MCP、2026-10-22、Linear JUN-297）

- `npm test` → **27 tests, 245 assertions, 0 failures**。
  - MCP の純関数のテスト（`test/mihari/mcp_test.cljk`）と stdio テスト（`test/mcp_stdio_test.cljk`）を含む。
  - stdio テストは `bin/mihari-mcp` を子プロセスで起動する。cwd は `/`、env は agent と同じ最小集合（PATH／HOME…）。
  - agent と同じく initialize → notifications/initialized → 要求 を流して stdin を閉じ、応答と exit 0 を確かめる。
  - `bin/mihari-mcp` を一時的に退けると 9 failures になるので、子プロセスの経路は空振りしていない。
- kotoba-lang/itonami-agent（`kotoba-lang/main` `709c948` の `src` を git archive で取り出して使用）の MCP クライアントで呼んだ。
  - `itonami.agent.mcp/discover` → `mcp__mihari__mihari_ingest_events` と `mcp__mihari__mihari_decide`、errors なし。
  - `itonami.agent.mcp/call` → `mihari_decide` は `{"priority":"high","next_status":"unresolved","regression":true}`。
  - `mihari_ingest_events` は fixture の envelope から 2 issue（Sentry の issue 形）を返した。
  - 出力に fixture の IP・email・cookie は含まれなかった。
- 初回起動だけ kbb が依存（`kotoba-lang/text` `bc551a3`）を取得する。そのメッセージは stderr に出て、stdout は JSON-RPC の行だけだった。

## 実測した「動かない」／確かめていないもの

- **aiueos への配線は未実装**。
  - `aiueos/mihari.edn` を session/grant（`apps/session` の app catalog、ADR-0080 の grant 経路）に載せた実行はしていない。kaikei と同じく kotoba-lang/aiueos 側の作業になる。
- **画面は guest の wasm を呼んでいない**。
  - ブラウザで判定するのは adapter（`mihari.core`、scittle が評価）で、guest と同じ結果であることは parity 表で 3 経路照合している。
  - wasm を UI から呼ぶ配線（typed ホストの読み込み、vector の受け渡し）は次の一手。
- **JVM では取り込み・書き出しが動かない**。
  - JSON の parse と UTF-8 の切り出しを JS ホスト（ブラウザ・kbb）で行う。依存ゼロを保つため JVM の分岐は ex-info を投げる。
  - 判定（`mihari.core`）は JVM でも動く形で書いてあるが、JVM のテストは回していない。
- **MCP の tool も guest の wasm を呼ばない**。画面と同じく adapter で判定し、guest との一致は parity 表で担保する。
- **itonami agent が model の判断で tool を呼ぶ run（推論 rail 経由）は試していない**。実測したのは MCP クライアントの discover / call まで。
- **ファイル選択ダイアログからの取り込みは手で操作していない**。
  - 確かめたのは、`File` を effect に渡す経路まで。
- **本家 Sentry の実データでの検証はしていない**。fixture は SDK の文書化された形に沿った合成データ。

## 分散状態の設計（未実装。ここから下は設計）

ADR 0005（itonami-app-plane）への割り当て:

1. **cell `mon`（DNA ごとの entry 規則）**
   - mihari の DNA は「event を足す」「status を動かす」の 2 種の entry。
   - 受理規則は guest の判定そのもの。
     - event entry: `fingerprint` が issue id を決め、`next-status` が遷移を決める。
     - status entry: `next-status` が -1 を返す組み合わせは拒否する。
   - entry は単調に足すだけで、判断は導出。受信順非依存で収束させるため、issue の状態は「最後の status entry 以降の event の有無」から導く。
2. **history `ito`（署名付き source chain）**
   - 各端末が自分の鍵で entry に署名して chain に積む。
   - 署名鍵は端末から出さない（itonami agent の「秘密は越えない」）。
3. **network `nuno`（per-DNA 同期）**
   - 同じ project を見るチームの端末どうしで entry を複製する。
   - 複製してよいのは scrub 済みの event だけにする（取り込み時の規則がそのまま複製の境界になる）。
4. **決済・anchor は持たない**。mihari の entry をチェーンに流す理由は無い。

## 本家 Sentry API 直結（ブロック中）

本家の Sentry（sentry.io や self-hosted）から issue を読む、または resolve を書き戻すには、次のものが要る（workspace AGENTS.md）。

- ブラウザから直接、operation ごとの新しい同意を得て接続する。
- 共有ブローカー `kotoba-lang/wasm-webcomponent/src/kotoba-client-runtime.js`（`kotoba.app.client-runtime.v1`）が要る。

そのブローカーは repo に存在しない（2026-10-22 確認）。
規約は product-local な代替を禁じているので、この dapp は本家への通信を一切持たない。
ブローカーが着地したら、記述子に Sentry の operation を宣言し、`each-operation` の同意で読み書きを足す。

- 宣言する endpoint origin・method/path・data categories（例: `GET /api/0/projects/{org}/{project}/issues/`）

## 次の一手（優先順）

1. aiueos 側で `:app/mihari` を app catalog に載せ、grant 経路で guest を起動する（kotoba-lang/aiueos の work）。
2. 画面から wasm guest を呼ぶ（adapter と並走させ、不一致を表示する）。
3. `mon` / `ito` / `nuno` の割り当てを実装する（scrub 済み event だけを複製する）。
4. ブローカーが着地したら、本家 Sentry の issue 読み出しと status 書き戻しを operation ごとの同意で足す。

## 実行 host と ABI

- guest は vector パラメータ（`fingerprint`）を使う。このため ABI は **KIR v4 / `kotoba.typed/externref-v1`**（typed-value ABI）。
- 実行 host は **kototama-browser-host-v1**（`kotoba-lang/amu/runtime/browser-host.mjs`）。test/guest_parity.mjs がこのホストで実行して照合した。
- kaikei の docs と同じく、aiueos の Chicory kernel ホストは typed ホストを持たないので、kernel 経路では動かない想定（未検証）。
