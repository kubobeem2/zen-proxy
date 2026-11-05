<p align="center">
  <img src="assets/logo.png" width="96" alt="zen-proxy" />
</p>

<p align="center"><b>zen-proxy</b></p>
<p align="center">OpenCode Zen の無料モデルを、どの AI コーディングエージェントからでも。</p>
<p align="center"><sub>アカウント不要・API キー不要。OpenAI と Anthropic に互換。手元で動きます。</sub></p>

<p align="center">
  <a href="https://discord.gg/Dw5Ctrtuw">
    <img src="https://img.shields.io/badge/Discord-Join%20the%20server-5865F2?style=flat-square&labelColor=1a1612&logo=discord&logoColor=white" alt="Join the Discord server">
  </a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-ccf73a?style=flat-square&labelColor=1a1612" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/bun-1.2%2B%20(or%20node%2018%2B%20BYOK)-8b8b8b?style=flat-square&labelColor=1a1612" alt="Bun 1.2+">
  <img src="https://img.shields.io/badge/dependencies-0-8b8b8b?style=flat-square&labelColor=1a1612" alt="Zero dependencies">
  <a href="#任意の-openai-互換エージェント">
    <img src="https://img.shields.io/badge/OpenAI_compatible-8b8b8b?style=flat-square&labelColor=1a1612&logo=openai" alt="OpenAI compatible">
  </a>
  <a href="#claude-code">
    <img src="https://img.shields.io/badge/Claude_Code-compatible-8b8b8b?style=flat-square&labelColor=1a1612&logo=anthropic" alt="Claude Code compatible">
  </a>
</p>

<p align="center">
  <img src="assets/brag-demo.gif" alt="zen-proxy を25秒で: インストール → 起動 → zen-claude → 任意の OpenAI 互換エージェントを接続" width="860" />
  <br />
  <sub>
    <a href="assets/brag-demo.mp4">▶ 音声つきの全編</a>
  </sub>
</p>

---

## このフォークについて

[12errh/zen-proxy](https://github.com/12errh/zen-proxy) のフォークです。`upstream/main` を追従しているので、上流の更新は `git pull` だけで取り込めます。上流の挙動はそのままに、次のものを足しています。

| 独自要素 | 何をするか |
|---|---|
| **複数アカウントのプール** | `zenKeys`、または `zenKeysFile` の `zenKeysRefs` に並べた `refs:` 名（例: `~/.dsh/.credentials.yaml`）を1つのプールとして使います。リクエストは次のアカウントから順に始まり、`401`/`429` が返ると次のアカウントへ渡し、最後の受け皿は匿名枠です。`/api/status` にプールと各アカウントの利用数（マスク済み）が出ます。 |
| **System One 分類器** | `POST /v1/systemone` が `jev-*` のリクエストをそのまま中継します。`jev-*` は `/v1/models` にも並び、チャット系のルートへ投げると `/v1/systemone` を案内する `400` を返します。上流 URL は共有の `/inference` ルートから組み立てるので、v2 のベースでも旧 `/inference/v1`・`/zen/v1` でも動きます。 |
| **経路の自動選択（direct ⇄ WARP）** | 上流への経路を**リクエスト毎に**選びます。経路固有の失敗（`FreeTierError`、接続失敗）では同じリクエストをもう一方で1回だけ試し、通った方を `cooldownMs` のあいだ使い続けます。プロセス全体を `HTTPS_PROXY` で縛らないので、出口の拒否で全滅しません（[WARP](#warp)）。 |
| **429 を「窓」として扱う** | `retry-after` 付きの429は、**ゲートウェイ共有の無料プール**が閉じた合図です（実測: `Authorization` なし・別アカウントのキー・ランダムな project hash・全モデル・WARP 経由のどれでも**同じ残り時間**）。窓が閉じている間は**上流を1回も叩かず**、ローカルで約15msで429＋リセット時刻を返します。`retry-after` の無い429だけを短いバースト冷却として1回だけ再試行します。 |
| **1リクエスト1コール** | 成功しても失敗しても、1リクエストが使う上流コールは1回。モデル固有の失敗のときだけ1ホップだけフォールバックします。アカウントや経路を総当たりしないので、日次枠が「数ターン」で消えません（以前は1ターンで最大40コール）。 |
| **同期は枠を食わない** | プローブは1モデルだけ。直近 `syncIdleMs`（既定2分）に実リクエストがあればスキップし、429が続いたら間隔を倍に（最大6時間）。プローブが429を踏んでもモデルを `dead` にしません。 |
| **実行環境と v2 wire の可視化** | `/api/status` が `runtime`（`bun 1.4.4` / `node …`）と `egress`（いまどちらの経路か、どちらが拒否されているか）を返し、設定タブに表示します。ゲートが実際に見る値——preamble モード（`auto` / `off` / 任意テキスト）、`x-opencode-client`、project hash、`b3`/`traceparent`——も同じ画面で変えられます。`node` で動いているときは「free tier needs bun」と出ます。 |

それ以外は上流どおりです。`models.json`、インストーラ、model-sync ワークフローも含みます。

---

## はじめかた

### インストール

```bash
curl -fsSL https://raw.githubusercontent.com/12errh/zen-proxy/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/12errh/zen-proxy/main/install.ps1 | iex
```

<sub>インストールはこれだけです。アカウントも API キーも `npm install` も要りません。あとは下から使うエージェントを選んでください。</sub>

---

<a id="claude-code"></a>

### Claude Code

```bash
zen-claude
```

<sub>Linux・macOS・Windows で同じコマンドです。</sub>

プロキシが起動していなければ起動し、いま使える無料 Zen モデルを Claude Code の `/model` に並べ、Claude Code を起動します。終了するとプロキシも止めます。既存の Claude Code 設定には触れません。

---

<a id="任意の-openai-互換エージェント"></a>

### 任意の OpenAI 互換エージェント

<sub>Cline、Roo Code、Continue、Aider、mimo、opencode 系フォークなど、`baseURL` を設定できるものなら何でも。</sub>

| 設定 | 値 |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API キー | `public` |
| モデル | `GET /v1/models` に出ているもの |

プロキシが上がっているか確認する:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"upstream":"https://opencode.ai/inference/openai/v1"}
```

<details>
<summary>プロキシを自分で起動する</summary>

```bash
zen-proxy     # http://127.0.0.1:8787 — ダッシュボードは /
```

止めるまで動き続けるので、エージェントの接続先は一度設定すればそのまま使い回せます。`zen-claude` はこれを自動でやって、終了時に片づけます。
</details>

---

## 使えるもの

| 機能 | 内容 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions（ストリーミング／非ストリーミング） |
| `POST /v1/responses` | OpenAI Responses API。両方向に変換します。Responses 形式で送れば Responses 形式で返り、chat 形式で送れば chat 形式の返りになります |
| `POST /v1/messages` | Anthropic Messages API。**Claude Code はこれを使います** |
| `POST /v1/messages/count_tokens` | Anthropic のトークン概算 |
| `POST /v1/systemone` | System One 分類器（`jev-1.13-free`）。リクエストも応答もそのまま中継します |
| `GET /v1/models` | いま動いているモデル一覧 |
| 自動フォールバック | `429` / `5xx` / モデル利用不可のとき、次の無料モデルを試します |
| モデルエイリアス | `gpt-4o` と呼べば、無料モデルが返ります |
| 認証 | 匿名の `Bearer public`、自分の Zen キー、複数アカウントのリクエスト毎ローテーション |
| ダッシュボード | `http://127.0.0.1:8787/` |

無料モデルのカタログ [`models.json`](models.json) は、GitHub Action が OpenCode の公開カタログから6時間ごとに更新します。

---

## なぜプロキシが必要か

OpenCode の無料モデルは、OpenCode CLI 本体からしか使えません。それ以外のクライアントには次のどちらかが返ります。

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
429 FreeUsageLimitError: Free usage limit reached …   ← いまはこちらが返る
```

OpenCode 2 以降、CLI 以外のクライアントが受け取るのは2つ目です。`retry-after` の窓が付き、自分の利用量は0のまま。これはあなたの枠ではなく、リクエストに対するゲートの判定です。

zen-proxy はそのゲートウェイの手前に立ち、エージェントの通信を CLI のものと見分けがつかない形にします。根拠はすべて、実際の OpenCode 2.1.4 のリクエストをバイト単位で採取した結果です。

<details>
<summary>実際に何を変えているか</summary>

| ゲートの要求 | zen-proxy の対応 |
|---|---|
| **Bun で動くこと。** ゲートは TLS/HTTP スタックの指紋を見ます。Bun の fetch なら `200` で流れるバイト列が、Node の fetch では同じ秒・同じセッションでも `429 FreeUsageLimitError` になります | `zen-proxy` / `zen-claude` は bun を優先します。node は BYOK キーなら動き、node 起動時は警告を出します |
| v2 エンドポイント `https://opencode.ai/inference/openai/v1` | これを使います。`/inference/v1` や `/zen/v1` を指した古い設定は自動で移行します |
| v2 の wire 同一性: `x-opencode-client`、`x-opencode-project`（インストール毎の sha1）、`b3`/`traceparent`、affinity ペア | CLI と同じ形式で全部送ります |
| **OpenCode のハーネス system テキスト**。CLI の preamble でない system プロンプトは、他がどれだけエージェントらしくても拒否されます（汎用プロンプト、冒頭1行だけ、約1.8KB で切ったもの、いずれも拒否） | 採取したハーネス preamble（`agent-preamble.txt`）を、エージェント自身の指示の前に、全ルートで、二重にならない形で前置します |
| OpenCode 自身のツール目録（`read` のスタブだけでは通りません） | 採取した v2 目録（`agent-tools.json`。名前が対応するのは read/edit/glob/grep/shell/write）を自分のツールの前に付け、対応する呼び出しはエージェント側の名前に戻し、残りは捨てます |
| `stream_options` と実際の `max_completion_tokens` を伴うストリーム | ヘルスプローブでは CLI の形を再現し、あなたのリクエストはそのまま転送します |

**bun で動かしてください**（`bun zen-proxy.mjs`、または bun があればそれを選ぶ `zen-proxy`/`zen-claude` 経由）。これだけは node で代用できません。ヘッダもセッションもボディもバイト単位で同じでも、ゲートは node のスタックを 429 にします。

応答についてはルールが1つだけあります。**返信は、エージェントが実際に実行できる呼び出しだけを持てる。** 自分のツールを持つターンは、その呼び出しを保持し（目録由来の呼び出しは名前を戻して返します）、それ以外——対応のない目録の名前や、プロバイダが勝手に作ったツール名——は落とします。`tool_choice` で1つに固定したターンは、その固定した呼び出しだけを残します。ツールを一切付けていない返信（タイトル生成や単純な ping）は、`tool_call` を全部落とします。ヘルスプローブも同じハーネス preamble + 目録 + 実際の問いを送ります（直列で、間隔を空けて。同一 identity からの連続モデルホップはまとめて 403 になるため）。だからダッシュボードの `ok` 行は「本当に応答が流れた」という意味になります。以前の `rate-limited` での待避はなくなりました（`FreeUsageLimitError` のバケットがモデルを削除したり dead 扱いしたりすることはありません）。
</details>

<details>
<summary>バグ報告の前に知っておきたいこと</summary>

- **匿名の無料枠に乗っています。** IP 単位の枠、共有プール、混雑する時間帯があります。安定させたいならキーを持ってきてください。
- **素の `curl` は 429/403 になります。** ゲートウェイは本物の*エージェント*の通信（ハーネス preamble、目録、それらしい wire）にしか応じません。上のエージェントはどれもこれを満たしますが、手作りのチャットクライアントは満たしません。
- **ヘルスプローブはエージェントの形をしています。** 同期は各モデルに、本物の v2 クライアントと同じもの——ハーネス preamble、OpenCode の目録、`stream_options`、実際のトークン予算——を、直列で間隔を空けて送ります（同一 identity からの連続アクセスはまとめて拒否されるため）。なので `ok` は「実際にストリームが返った」という意味です。`FreeUsageLimitError` のプローブがモデルを dead にしたり一覧から消したりすることはありません。
- **フォールバックは名乗ります。** `zen_served_by` と `x-zen-served-by` / `x-zen-fallback` ヘッダで分かります。
- **`agent-tools.json` と `agent-preamble.txt` は OpenCode v2.1.4 のリクエストの採取物です。** OpenCode がハーネス文言やツールスキーマを変えたら、本物のリクエストから両方を取り直してください（ゲートは preamble の指紋を見ます。先頭139文字では足りません）。preamble はプレーンテキスト、tools は素の配列でも `{"tools":[...]}` でも読めます。
</details>

---

## 無料枠の「窓」と残量

無料枠は **ゲートウェイ側の共有プール** です。条件を1つずつ変えて `retry-after` を測ると、どれも同じ値でした。

| 変えた条件 | `retry-after` |
|---|---|
| `Authorization` なし（匿名） | 4978 |
| アカウントAのキー | 4976 |
| アカウントBのキー | 4973 |
| アカウントC / D のキー | 4971 / 4969 |
| `x-opencode-project` をランダム化 | 同じ |
| モデルを5種類に変更 | 同じ |
| WARP 経由（別の出口IP） | 同じ |

つまり枠は**アカウント・キー・ワークスペース・出口IP・モデルのどれでも変わりません**。キーやアカウントを増やしても無料枠は増えず、出口を変えても増えません。

窓は**ローリング**です。固定の時刻にリセットされるのではなく、`retry-after` が「次に1回通るようになるまで」を秒で示します（実測でも 00:00 UTC 前後だったり、翌 00:27 UTC だったりと動きました）。したがって**リセット時刻を推測せず、`retry-after` をそのまま信頼する**のが正解で、zen-proxy もそうしています。（以前「出口IPの枠」「アカウント単位の枠」と書いたのは誤りでした。）

有料モデルは同じキーで `403 Model access is disabled` を返します（このアカウントでは有効化されていません）。

zen-proxy はこの窓を状態として持ちます:

| 状態 | 挙動 |
|---|---|
| 窓が閉じている | 上流コール**0**。ローカルで約15msで `429`＋`retry-after`＋`x-zen-quota-window` を返す。アカウント/経路の総当たりもしない |
| 窓が明けた | 次のリクエストがそのまま確認になる（プローブを連打しない）。200 なら通常運転に戻る |
| 通常時 | 1クライアントリクエスト＝上流1コール。モデル固有の失敗のときだけ1ホップだけフォールバック |

現在の残量は `GET /api/status` の `quota`（`windowUntil` / `remainingSec` / `scope` / `todaySuccess` / `todayRefused`）と、ダッシュボードの `free window: closed until …` で確認できます。

---

## 設定

`zen-proxy.json` は初回起動時に作られ、ホットリロードされ、ダッシュボードから編集できます。環境変数は起動時に優先されます。

<details>
<summary>キー</summary>

| キー | 既定値 | 説明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8787` | バインド先（変更には再起動が必要） |
| `upstream` | `https://opencode.ai/inference/openai/v1` | Zen ゲートウェイのベース（v2。カタログ取得だけは `/inference/v1` のまま） |
| `ua` / `autoUA` | `opencode/latest/2.1.4/cli` / `true` | v2 CLI の UA 形式。自動追従は v2 形式の UA には触れません（npm にあるのは 1.x 系だけ） |
| `clientName` / `projectHash` / `tracing` | `cli` / 自動 / `true` | v2 の同一性ヘッダ: `x-opencode-client`、インストール毎の `x-opencode-project`（`directory:<cwd>` の sha1）、`b3`/`traceparent` |
| `injectSession` | `true` | セッションヘッダのペアと affinity ペアを生成して送る |
| `agentPreamble` | `""`（= auto） | `""`/`auto` → 同梱のハーネス preamble、`off`/`none` → 付けない、それ以外 → その文字列をそのまま使う |
| `agentTools` | `true` | OpenCode の v2 目録を全リクエストで自分のツールの前に付ける。応答はエージェントが実行できる呼び出しだけを残し、対応するものは名前を戻し、残りは捨てる |
| `defaultModel` | `""` | 空 = 動く無料モデルの先頭を自動で選ぶ |
| `fallbackModels` | *[`models.json`](models.json) から* | 失敗時に順番に試す。省略するとカタログに追従。一度保存すると自分の一覧に固定 |
| `modelAliases` | `{}` | 例: `{"gpt-4o": "deepseek-v4.1-flash-free"}` |
| `responsesModels` | `["gpt-5*","gpt-6*","grok-*","muse-spark-*"]` | `/v1/responses` で扱うモデル。パターンは `*` で終われます |
| `defaultZenKey` | `""` | 匿名の `public` の代わりに使う自分の Zen キー |
| `zenKeys` / `zenKeysFile` / `zenKeysRefs` | `[]` / `""` / `[]` | Zen の資格情報を追加します。キーの配列か、`~/.dsh/.credentials.yaml` のような資格情報ファイルから読む `refs:` 名。2つ以上あるとリクエスト毎にローテーションし、`401`/`429` を返したキーは次のキーへ渡し、匿名枠は最後の受け皿として残ります。 |
| `proxyKey` | `""` | クライアントにこれを要求します。ダッシュボードと `/api/*` もロックされます |
| `rateLimitMax` / `rateLimitWindowMs` | `0`（無効） / `60000` | クライアント単位のレート制限 |
| `timeoutMs` / `cacheMs` | `120000` / `30000` | 上流のタイムアウト、`/v1/models` のキャッシュ TTL |
| `autoSync` / `autoSyncIntervalMs` | `true` / `3600000` | 新しく出た無料モデルの実行時ディスカバリ |
| `syncProbeModels` / `syncIdleMs` | `1` / `120000` | 同期でプローブするモデル数（`0` で全件）と、実リクエストからこの時間は同期を走らせない間隔 |
| `freeTierFastFail` | `true` | `FreeUsageLimitError` / `FreeTierError` を「モデルの失敗」ではなく「アカウントと出口の判定」として扱い、カタログを歩かず即返す |
| `trustForwarded` | `false` | リバースプロキシ配下で `x-forwarded-for` を信頼する |
| `warpProxy` | `{ "enabled": false, "port": 8890, "hop": "", "hops": [], "fallback": "direct", "mode": "auto", "cooldownMs": 60000, "rotateCommand": "warp-cli --accept-tos disconnect && warp-cli --accept-tos connect", "rotateCooldownMs": 60000, "rotateTimeoutMs": 90000, "autoRotateOnEgressReject": false }` | 2つ目の出口（HTTP CONNECT プロキシ。Cloudflare WARP のプロキシモードなど）。`mode` は `auto`（direct から始めて拒否されたら切替）/ `always`（固定）/ `warp-only`（固定＋directへは絶対に落ちない）/ `off`。`hops` は複数ホップ（ラウンドロビン）。`rotateCommand` / `rotateCooldownMs` / `rotateTimeoutMs` は出口IPの取り直し用。`autoRotateOnEgressReject` は既定オフの自動取り直し。[WARP](#warp) を参照 |

`HOST` `PORT` `ZEN_URL` `ZEN_UA` `ZEN_CLIENT` `ZEN_PROJECT_HASH` `ZEN_TRACING=0` `INJECT_SESSION=0` `AUTO_UA=0` `UA_REFRESH_MS` `AGENT_TOOLS=0` `AGENT_PREAMBLE=off` `ZEN_PROXY_AGENT_TOOLS` `ZEN_PROXY_AGENT_PREAMBLE` `PROBE_AUTH` `DEFAULT_MODEL` `FALLBACK_MODELS` `MODEL_ALIASES` `RESPONSES_MODELS` `PROXY_KEY` `ZEN_KEY` `ZEN_KEYS` `ZEN_KEYS_FILE` `ZEN_KEYS_REFS` `TRUST_FORWARDED=1` `TIMEOUT_MS` `CACHE_MS` `RATE_LIMIT_MAX` `RATE_LIMIT_WINDOW_MS` `AUTO_SYNC=0` `AUTO_SYNC_MS` `SYNC_PROBE_MODELS` `SYNC_IDLE_MS` `FREE_TIER_FAST_FAIL=0` `WARP_PROXY_ENABLED=0` `WARP_PROXY_PORT` `WARP_PROXY_HOP` `WARP_PROXY_HOPS` `WARP_PROXY_FALLBACK` `WARP_PROXY_MODE` `WARP_PROXY_COOLDOWN_MS` `WARP_PROXY_ROTATE_COMMAND` `WARP_PROXY_ROTATE_COOLDOWN_MS` `WARP_PROXY_ROTATE_TIMEOUT_MS` `WARP_PROXY_AUTO_ROTATE_ON_EGRESS_REJECT=1` `ZEN_PROXY_CONFIG`

匿名の `public` アクセスは IP 単位の枠を共有していて、混雑することがあります。安定させたいなら `defaultZenKey` を設定するか、リクエスト毎に `x-zen-key` を送ってください。複数アカウント（`zenKeys`、または `zenKeysFile` の refs）を設定すると順番に使われるので、1アカウントあたりの枠が上限ではなくなります。`/api/status` にプールと各アカウントの利用数（マスク済み）が出ます。
</details>

<details>
<summary>ダッシュボード</summary>

`http://127.0.0.1:8787/` — 上流の死活と稼働時間、リクエストのライブ表示、モデルのワンクリック試験、設定の即時編集、ログの末尾表示。

![zen-proxy dashboard](assets/dashboard.png)
</details>

<details>
<summary>HTTP API</summary>

| メソッド | パス | 説明 |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `POST` | `/v1/messages/count_tokens` | Anthropic のトークン概算 |
| `GET` | `/v1/models` | 利用できるモデル |
| `GET` | `/health` | ヘルスチェック（常に開いています） |
| `GET` | `/` | ダッシュボード |
| `GET`/`PUT` | `/api/config` | 設定の読み書き |
| `GET` | `/api/status` | 統計と上流の状態。`?refresh=1` で出口IPをホップ経由で測り直す |
| `POST` | `/api/warp/rotate` | WARPの出口IPを取り直す（localhostのみ。`proxyKey` 設定時は認証も要る）。[WARP](#warp) を参照 |
| `POST` | `/api/test` | モデルを1つ試す — `{"model":"..."}` |
| `GET` | `/api/logs` | ログの末尾 |
| `POST` | `/api/sync` | モデルディスカバリをやり直す |
| `POST` | `/api/reset` | リクエスト統計をリセット |
</details>

<details>
<summary>サービスとして常駐させる（Linux）</summary>

`install.sh` が systemd ユニットのインストールを提案します（`PATH` に `bun` があれば bun を優先します）。手動なら:

```bash
sudo systemctl enable --now zen-proxy
```

Bun が `PATH` の外にある場合（例: `~/.bun/bin/bun`）は、ユニットから明示的に指してください。無料枠は Node のスタックには応じません:

```ini
ExecStart=/home/<user>/.bun/bin/bun /path/to/zen-proxy.mjs
```
</details>

<details>
<summary><code>zen-claude</code> を使わずに手で動かす</summary>

どちらのランチャーも、環境変数を export せず `--settings` を渡します。**Claude Code は `~/.claude/settings.json` の env を読み、それがシェルより優先される**ため、そのファイルがすでに `ANTHROPIC_BASE_URL` を設定していると `export` は黙って無視されます。既存の設定はそのまま残り、素の `claude` は今までどおりそれを使います。

```bash
claude --settings ./claude/zen-proxy.settings.json
```

ピッカーは `bin/make-settings.mjs` が生成します。プロキシから実際のモデル一覧を読み（取れなければ `models.json`）、各行に `behavesAs` を設定します。Claude Code は見慣れないモデル ID でも妥当な既定値で扱え、上流へはその ID がそのまま送られます。

`zen-claude` が `command not found` になる場合は、まず `ls -l ~/.local/bin/zen-claude` を見てください。シンボリックリンクが無ければインストーラを再実行します。リンクがあるのに見つからない場合だけ、`PATH` が古いのが原因です:

```bash
export PATH="$HOME/.local/bin:$PATH"                          # この端末だけ
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc      # 永続化
```
</details>

---

## WARP

[Cloudflare WARP](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/download/) を **2つ目の出口** として使います。出口アドレスそのものが拒否されると `FreeTierError: … abusive traffic from this IP address` が返るので、そのときの逃げ道が WARP です。

**ただし、無料枠の「窓」は出口では変わりません。** 実測では、`Authorization` なし・別アカウント・ランダムな project hash・全モデルのどれでも、direct と WARP で `retry-after` が同値でした（＝枠はゲートウェイ共有）。したがって `retry-after` 付きの429では経路を切り替えません（1コールの無駄）。切替が効くのは、出口IP自体が拒否されたとき・接続が失敗したときだけです。

ただし**固定してはいけません**。実測では、WARP の出口が全リクエストに `429 FreeUsageLimitError` を返しているあいだ、ホスト自身の出口は12連続で `200` を返しました。逆に以前は自分の出口が拒否され、WARP だけが通っていました。どちらが生きているかは数分で入れ替わるため、zen-proxy は**リクエスト毎に経路を選びます**。

- `warpProxy.mode: "auto"`（既定）— direct から始め、`FreeUsageLimitError` / `FreeTierError` が返ったら同じリクエストをもう一方の経路で1回だけ試します。通った方を `warpProxy.cooldownMs`（既定5分）のあいだ使い続け、拒否された方はその間避けます。
- `warpProxy.mode: "always"` — WARP に固定（従来の動き）。
- `warpProxy.mode: "warp-only"` — WARP に固定し、**direct へは絶対に落ちません**。ホップが死んでいたらリクエストは 502/503 で失敗します（素のIPは漏れない）。リレーを `--fallback none` で動かすことが条件で、そうでないリレーでは推論リクエスト自体が 503 になります。ホスト全体のルーティングは変わりません——WARP を通るのはこのプロキシの上流通信だけです。
- `warpProxy.mode: "off"` — direct のみ。

ホップは HTTP CONNECT プロキシです。Cloudflare WARP のプロキシモードは `127.0.0.1:40000` で喋り、他の CONNECT プロキシも同じです。そこへは小さな中継 `scripts/warp-relay.mjs` を介します。中継はトンネルをホップ経由で開き、ホップに届かなければ直接ソケットに切り替えるので、WARP が止まってもプロキシは使えます。

```bash
sudo bash deploy/install-warp.sh          # WARP + 中継ユニット + zen-proxy の drop-in
sudo WARP_ONLY=1 bash deploy/install-warp.sh  # fail-closed (warp-only) で入れる
curl -s http://127.0.0.1:8890/__status    # トンネル数、ホップ経由か直接か
curl -s http://127.0.0.1:8787/api/status  # egress: いまどちらの経路か、どちらが拒否中か
```

インストールされるもの:

| 部品 | 場所 | 役割 |
|---|---|---|
| `cloudflare-warp` | apt（公式リポジトリ） | ホップ本体。プロキシモードで動き、ホストのルーティングには触れません |
| `zen-proxy-warp-relay.service` | `/etc/systemd/system` | 中継を `127.0.0.1:8890` で動かす |
| `zen-proxy.service.d/warp-proxy.conf` | `/etc/systemd/system` | ホップの場所（`WARP_PROXY_HOP`）と `WARP_PROXY_MODE=auto` を宣言するだけ |

**`HTTPS_PROXY` をユニットに入れないでください。** プロセス全体の env プロキシは全リクエストを1つの出口に固定し、その出口が拒否された瞬間に全滅します（自動選択も効かなくなります）。起動時に env プロキシを見つけたら、zen-proxy は警告を出します。ホップのアドレスやポートを変えたときだけ再起動が必要で、`mode` の変更は次のリクエストから反映されます。

### オン／オフの切り替え

`warpProxy.mode` が唯一のスイッチです（`zen-proxy.json` の値が env より優先されます）。

| 値 | 動き |
|---|---|
| `auto`（既定） | direct から始め、**出口固有**の失敗（403 `FreeTierError`、接続失敗）のときだけ WARP へ切り替え |
| `always` | WARP 固定 |
| `warp-only` | WARP 固定＋directへは絶対に落ちない（fail closed。リレーは `--fallback none` が要る） |
| `off` | WARP を使わない（direct のみ。起動ログは `egress: direct only (hop disabled)`） |

```bash
# direct 固定にする（WARP を止める）
curl -s -X PUT http://127.0.0.1:8787/api/config \
  -H 'content-type: application/json' -d '{"warpProxy":{"mode":"off"}}'
sudo systemctl disable --now zen-proxy-warp-relay
warp-cli --accept-tos disconnect

# 元に戻す
warp-cli --accept-tos connect
sudo systemctl enable --now zen-proxy-warp-relay
curl -s -X PUT http://127.0.0.1:8787/api/config \
  -H 'content-type: application/json' -d '{"warpProxy":{"mode":"auto"}}'
```

ダッシュボードの「Upstream egress」からも同じ切り替えができます。`/api/status` の `egress` に `mode` / `active` / `healthy` が出ます。

### 複数ホップ

`warpProxy.hops` に CONNECT プロキシを並べると、リレーがトンネル毎にラウンドロビンします。CONNECT を拒否したホップは `cooldownMs` のあいだ避けられ、残りが回り続けます。未設定時は従来の単一ホップ（`warpProxy.hop`）のままです。ホップ毎の状態は `/api/status` の `warp.hops`（`healthy` / `avoidForSec` / `viaHop`）に出ます。

```bash
# 2つ目の warp-cli インスタンスを別ポートのプロキシモードで用意してから
sudo WARP_PROXY_HOPS="http://127.0.0.1:40000,http://127.0.0.1:40001" bash deploy/install-warp.sh
```

2つ目のインスタンスは `warp-cli` の2つ目の登録（別ポートで `mode proxy`）が必要です。スクリプトは自動では作りません——1インスタンス＝1出口が WARP の単位なので、増やすときはそのインスタンス側で `warp-cli --accept-tos connect` まで済ませておいてください。

### 出口IPの取り直し（rotate）

WARP の出口IPそのものが拒否されたとき（403 `FreeTierError`）、WARP セッションを作り直すと別の出口IPになることがあります。`warp-cli disconnect && warp-cli connect` を回すだけの軽い操作で、ホストのルーティングには触れません。

```bash
# いまの出口IPを確認する（ホップ経由で測る。毎リクエストは測らない）
curl -s "http://127.0.0.1:8787/api/status?refresh=1" | python3 -c "import json,sys; print(json.load(sys.stdin)['egress'])"

# 出口IPを取り直す（localhostからのみ。proxyKey 設定時は -H "Authorization: Bearer <key>" も要る）
curl -s -X POST http://127.0.0.1:8787/api/warp/rotate
# {"ok":true,"ipBefore":"203.0.113.42","ipAfter":"198.51.100.7","changed":true,"at":"..."}
```

実行中は 409、クールダウン中（既定60秒・完了時刻から測る）は 429（`retryAfterSec` 付き）になります。取り直すコマンドは `warpProxy.rotateCommand` で変えられます（設定ファイルの値だけが使われ、リクエストでコマンドは指定できません）。

**自動の取り直しは既定オフです。** `warpProxy.autoRotateOnEgressReject: true` のときだけ、出口固有の拒否（403 `FreeTierError`・接続失敗）で1回だけ自動で取り直します。**`retry-after` 付きの429では絶対に取り直しません。** あれはゲートウェイ共有の無料プールの「窓」で、出口IPを変えても残り時間は変わらないからです（[無料枠の「窓」と残量](#無料枠の窓と残量)）。窓が閉じているあいだ rotate を回しても、開くのは早くなりません。

元に戻す:

```bash
sudo systemctl disable --now zen-proxy-warp-relay
sudo rm /etc/systemd/system/zen-proxy-warp-relay.service \
         /etc/systemd/system/zen-proxy.service.d/warp-proxy.conf
sudo systemctl daemon-reload && sudo systemctl restart zen-proxy
sudo warp-cli --accept-tos registration delete && sudo apt-get remove -y cloudflare-warp
```

知っておきたいこと: WARP 経由のとき上流から見えるのは自分のアドレスではなく WARP の出口です。WARP は接続ごとに出口を割り当てるため、1つのアドレスに紐づいた枠が付いてくる保証はありません。Bun は1本のトンネルを再利用するので、`/__status` のトンネル数はリクエスト毎には増えません。

---

<p align="center">
  <sub>💬 <a href="https://discord.gg/Dw5Ctrtuw">Discord に参加</a> — インストールの相談、トラブルシュート、いま速い無料モデルの情報。</sub>
  <br />
  <sub>冒頭のデモ動画は brag スキルで作りました。</sub>
</p>

<p align="center">
  <sub>機械可読版: <a href="llms.txt">llms.txt</a> &nbsp;·&nbsp; <a href="llms-full.txt">llms-full.txt</a></sub>
</p>

<p align="center">
  <a href="https://github.com/12errh/zen-proxy/issues">
    <img src="https://img.shields.io/github/issues/12errh/zen-proxy?style=flat-square&labelColor=1a1612&color=8b8b8b" alt="Open issues">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-8b8b8b?style=flat-square&labelColor=1a1612" alt="MIT License">
  </a>
</p>
