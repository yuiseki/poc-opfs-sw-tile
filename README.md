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
4. 「キャッシュ全消去」で OPFS が空になること

## 技術メモ

- **OPFS の書き込みは Service Worker から async API (`createWritable`) で行う**。同期 API (`createSyncAccessHandle`) は専用 Worker 限定で SW では使えない。
- ブロックは固定長 (64KB) に整列。連続する未キャッシュ範囲はまとめて 1 回の Range で取得し、リクエスト数を抑える。
- 総ファイルサイズは最初の `Content-Range` レスポンスから学習し `meta.json` に保存（`Content-Range` ヘッダの組み立てに使用）。
