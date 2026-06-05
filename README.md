# poc-opfs-sw-tile

**OPFS + Service Worker で、アクセスしたベクトルタイルだけをローカルにキャッシュする PoC。**

タイルソースは [`planet.pmtiles`](https://z.yuiseki.net/static/openstreetmap/planet/planet.pmtiles)（約 **83GB** の単一 PMTiles アーカイブ）。
ファイル全体を落とすのではなく、MapLibre が表示に必要な分だけ出す **HTTP Range リクエストを Service Worker が横取り**し、
**64KB ブロック単位で OPFS (Origin Private File System) に保存**する。ユーザーが実際に見た範囲だけがキャッシュされ、
再訪時やオフライン時は OPFS から復元される。

## 仕組み

```
MapLibre GL ──(pmtiles:// プロトコル)──▶ fetch(Range: bytes=start-end)
                                              │
                                    ┌─────────▼──────────┐
                                    │   Service Worker    │  ← fetch を横取り
                                    │  (src/sw.ts)        │
                                    └─────────┬──────────┘
                          キャッシュ命中?       │
                ┌──────── yes ────────┐        └──── no ────┐
                ▼                                            ▼
        OPFS からブロック読み出し                  ネットワークから Range 取得
        (ネットワーク不要)                          → OPFS に保存 → 返す
```

- **PMTiles の Range リクエスト** → 64KB ブロックに整列して OPFS (`pmtiles-blocks/`) にキャッシュ。
- **スタイル / グリフ / スプライト / MapLibre CSS** → Cache API で cache-first。
- **アプリシェル (index.html / main.js)** → install 時にプリキャッシュ。オフラインでもアプリが起動する。

左上パネルの **「OPFS キャッシュを使う」チェックボックス**で、OPFS 経由のキャッシュを ON/OFF できる。
OFF にすると pmtiles の Range リクエストは OPFS を読み書きせず常にネットワークへ流れるので、
キャッシュあり/なしの挙動を比較できる。設定は `localStorage` に保存し、Service Worker へは
`postMessage` で伝える（SW 側は再起動に備え Cache API に永続化）。

また **「描画完了まで」** に、描画にかかった時間 (ms) を表示する。

- **初回（リロード直後）**: ナビゲーション開始 → 最初の `idle`（描画完了）までを表示し `(初回)` を付ける。
  リロードからタイルが出揃うまでの体感速度がそのまま分かる。
- **以降**: ズーム/パンの `movestart`（再描画開始）→ `idle` の差分で上書きする。

レンダリング自体は MapLibre が行うため、この時間はタイル取得（通信）が支配的で、
OPFS キャッシュの ON/OFF で差が分かる（`idle` は記号のフェード完了も含むため
一定のオーバーヘッドが乗る点に注意）。

ポイント:

- 83GB のファイルは**絶対に丸ごと落とさない**。保存されるのは「見た場所」のバイト範囲のみ。
- Service Worker は `clients.claim()` で即座にページを制御するため、**初回アクセスの最初のリクエストから横取り**できる（リロード不要）。

## 構成

```
docs/                   ← GitHub Pages の公開ディレクトリ
  index.html            UI（地図 + キャッシュ統計パネル）
  main.js               ビルド成果物（コミットする）
  sw.js                 ビルド成果物（コミットする）
  .nojekyll             Jekyll 処理を無効化
src/main.ts             ページ側: SW 登録・地図初期化・統計表示
src/sw.ts               Service Worker: OPFS ブロックキャッシュ本体
build.mjs               esbuild ビルド（src/*.ts → docs/main.js, docs/sw.js）
e2e/opfs-cache.spec.ts  Playwright による E2E テスト
playwright.config.ts    E2E 設定（ビルド→docs を静的配信→テスト）
```

`docs/main.js` / `docs/sw.js` はビルド成果物だが、**GitHub Pages はビルドを行わず
`docs/` をそのまま配信する**ため、リポジトリにコミットする（`.gitignore` しない）。
ソースを変更したら `npm run build` で再生成してコミットすること。

## 使い方

```bash
npm install
npm run dev          # ビルドして http://localhost:8080 で配信
# ブラウザで http://localhost:8080 を開く
```

> Service Worker は **localhost か HTTPS** でのみ動作する（secure context 必須）。

地図を動かすと、左上パネルの「ブロック数 / サイズ」が増えていく＝アクセスした範囲が OPFS に貯まっていく。
DevTools の Network を Offline にしてリロードしても、キャッシュ済みの範囲はそのまま表示される。

## GitHub Pages で公開

このリポジトリは `docs/` をそのまま公開できる。

1. ソースを変更したら `npm run build`（→ `docs/main.js`, `docs/sw.js` を再生成）してコミット。
2. GitHub の **Settings → Pages** で **Source: Deploy from a branch**、**Branch: `main` / `docs`** を選択。
3. `https://<user>.github.io/<repo>/` で公開される。

相対パス（`./sw.js` など）で組んであるため、リポジトリ名のサブパス配下
（`https://<user>.github.io/<repo>/`）でも Service Worker のスコープが正しく機能する。
Pages は HTTPS なので Service Worker / OPFS はそのまま動作する。

### スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | `src/*.ts` を `main.js` / `sw.js` にバンドル |
| `npm run watch` | ファイル監視ビルド |
| `npm run dev` | ビルド + 静的配信（:8080） |
| `npm run typecheck` | `tsc --noEmit` で型チェック |
| `npm test` | E2E テスト（自動でビルド & 配信して実行） |

## E2E テスト

[Playwright](https://playwright.dev/) で実ブラウザ（Chromium）を使って検証する。

```bash
npm run e2e:install   # 初回のみ: Chromium を取得
npm test
```

検証内容:

1. コールドスタートで SW がルートスコープ (`http://localhost:8080/`) で制御すること
2. 地図操作でアクセスした範囲だけが OPFS にキャッシュされること（206 が SW 由来 / 容量が planet 全体に対し極小）
3. オフラインにしてリロードしても、アプリシェル + OPFS から地図を復元できること
4. 同一ブロックへの同時要求が 1 回の fetch に集約されること（inFlight）
5. 同時ネットワーク取得数が上限(12)を超えないこと（セマフォ）
6. 二度目の同一ブロック要求がメモリキャッシュから返ること（OPFS/ネットワーク不要）
7. 未キャッシュブロックで OPFS 読み取りを試みないこと（索引でスキップ）
8. 取得した未キャッシュブロックが OPFS と cachedBlocks 索引の両方に載ること
9. 「キャッシュ全消去」で OPFS が空になること

## 技術メモ

- **OPFS の書き込みは Service Worker から async API (`createWritable`) で行う**。同期 API (`createSyncAccessHandle`) は専用 Worker 限定で SW では使えない。
- ブロックは固定長 (64KB) に整列。各ブロックは 1 回の Range リクエストで取得する。
- **OPFS 読み取りは並列**。`ensureBlocks` は必要ブロックを `Promise.all` で同時に読む（逐次 `await` しない）。
- **メモリ内ブロックキャッシュ (簡易 LRU)**: SW 生存中だけ、最近読んだブロックを `Map<blockIndex, Uint8Array>` に保持（`MEM_MAX_BLOCKS=512` ≒ 32MiB）。`getFileHandle→getFile→arrayBuffer` の OPFS 経路を毎回辿らずに済むため、ホットなブロック（ヘッダ・ディレクトリ・近接タイル）の再読み出しが速い。`acquireBlock()` はメモリ→OPFS→ネットワークの順に当たる。
- **OPFS ブロック索引 (cachedBlocks Set)**: 起動後に一度だけディレクトリを走査し、存在するブロック番号を `Set<number>` に保持する。未キャッシュブロックでは OPFS の読み取り(`getFileHandle` の reject)を試みずに済み、即ネットワーク取得へ回せる。取得・消去に応じて索引を更新し、索引にあるのに実体が無い場合は整合を取って取得し直す。
- **同時 Range 要求の重複取得防止 (inFlight Map)**: MapLibre は同時に多数のタイルを要求し、近接タイルが同じ内部範囲(=同じブロック)を要求しうる。`Map<blockIndex, Promise>` で「取得中」の Promise をブロック単位で共有し、同一ブロックの二重 fetch / 二重 write を防ぐ。`acquireBlock()` が起点。
- **同時ネットワーク取得数の上限 (セマフォ)**: 上流リクエストと OPFS 書き込みの集中を避けるため、実ネットワーク取得の同時実行を `MAX_CONCURRENT_FETCHES`(=12) に制限する。キャッシュ済みブロックの読み出しは上限の対象外（即返す）。
- 総ファイルサイズは最初の `Content-Range` レスポンスから学習し、**メモリ変数 (`totalSizeCache`) に保持**して Range レスポンスのたびに OPFS を読まない。`meta.json` への永続化は**レスポンス経路から外して fire-and-forget**（メモリ値で即応答し、書き込みは待たない）。
- **アプリシェル (index.html / main.js) は network-first**。オンライン時は常に最新を取得するため、デプロイした新しいコードが確実に反映される（cache-first だと旧 SW / 旧 JS が残り続ける）。オフライン時のみプリキャッシュにフォールバック。
- **SW の更新**: `skipWaiting` + `clients.claim` で即時有効化し、登録は `updateViaCache: 'none'`。新しい SW が制御を引き継いだら（更新時のみ）ページを 1 度だけ自動リロードして新しい資産を読み込む。`activate` 時に旧バージョンのキャッシュを削除する。OPFS のタイルキャッシュは更新で消さず引き継ぐ。
