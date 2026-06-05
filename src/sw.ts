/**
 * Service Worker: OPFS によるベクトルタイル(PMTiles)のローカルキャッシュ
 * ------------------------------------------------------------------
 * planet.pmtiles は ~83GB の巨大な単一ファイル。MapLibre + pmtiles プロトコルは
 * 「いま表示している場所」のタイルだけを HTTP Range リクエスト(bytes=start-end)で取得する。
 *
 * この SW はそうした Range リクエストを横取りし、固定長ブロック(64KB)単位で
 * OPFS(Origin Private File System)に保存する。保存するのは
 * 「ユーザーが実際にアクセスしたバイト範囲」だけ ── ファイル全体は決して落とさない。
 *
 *   - キャッシュにあるブロック  -> OPFS から読み出して返す(ネットワーク不要)
 *   - 無いブロック             -> ネットワークから取得し OPFS に保存してから返す
 *
 * これにより、一度見た範囲のタイルはオフラインでも表示でき、再訪時も高速になる。
 */

// Service Worker のグローバルスコープとして型付けする
const sw = self as unknown as ServiceWorkerGlobalScope;

const VERSION = "v1";
const PMTILES_URL =
  "https://z.yuiseki.net/static/openstreetmap/planet/planet.pmtiles";

// 1 ブロックのサイズ。Range を必ずこの境界に揃えて取得・保存する。
const BLOCK_SIZE = 64 * 1024; // 64KiB

// OPFS 内のディレクトリ名(ブロックファイルと meta.json を格納)
const OPFS_DIR = "pmtiles-blocks";

// スタイル / グリフ / スプライトなどの静的アセット(これらは Cache API で cache-first)
const ASSET_PREFIX = "https://z.yuiseki.net/static/maps/";
const ASSET_CACHE = `map-assets-${VERSION}`;

// MapLibre の CSS(CDN)
const MAPLIBRE_CSS =
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";

// OPFS キャッシュの ON/OFF 設定。ページからの postMessage で切り替える。
// SW は再起動でメモリが消えるため Cache API に永続化し、初回参照時に読み込む。
const SETTINGS_CACHE = `settings-${VERSION}`;
const SETTINGS_KEY = "https://sw.settings/cache-enabled";
let cacheEnabled: boolean | null = null; // null = 未ロード

async function loadCacheEnabled(): Promise<boolean> {
  if (cacheEnabled !== null) return cacheEnabled;
  try {
    const cache = await caches.open(SETTINGS_CACHE);
    const res = await cache.match(SETTINGS_KEY);
    cacheEnabled = res ? (await res.text()) === "1" : true; // 既定は ON
  } catch {
    cacheEnabled = true;
  }
  return cacheEnabled;
}

async function saveCacheEnabled(enabled: boolean): Promise<void> {
  cacheEnabled = enabled;
  const cache = await caches.open(SETTINGS_CACHE);
  await cache.put(SETTINGS_KEY, new Response(enabled ? "1" : "0"));
}

// オフラインでも起動できるようプリキャッシュするアプリシェル
const APP_SHELL = ["./", "./index.html", "./main.js", MAPLIBRE_CSS];

// -------------------- ライフサイクル --------------------

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      // 1 つ失敗しても install を止めない
      await Promise.all(
        APP_SHELL.map((u) =>
          cache.add(u).catch((e) => console.warn("[sw] precache miss", u, e))
        )
      );
      // 待機せず即座に有効化(PoC なので常に最新を使う)
      await sw.skipWaiting();
    })()
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 古いバージョンのキャッシュを掃除(設定とアセットの現行版のみ残す)
      const keep = new Set([ASSET_CACHE, SETTINGS_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => !keep.has(n)).map((n) => caches.delete(n))
      );
      // 既存ページも即座にこの SW の制御下に置く
      await sw.clients.claim();
    })()
  );
});

// ページからの OPFS キャッシュ ON/OFF 切り替えを受け取る
sw.addEventListener("message", (event) => {
  const data = event.data as { type?: string; enabled?: boolean } | null;
  if (data?.type === "set-cache") {
    event.waitUntil(saveCacheEnabled(!!data.enabled));
  } else if (data?.type === "debug-net-count") {
    // 診断用: これまでのネットワークブロック取得回数を返す
    event.ports[0]?.postMessage({ count: networkBlockFetches });
  }
});

// -------------------- fetch 横取り --------------------

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = req.url.split("?")[0];

  // 1) PMTiles の Range リクエスト -> OPFS ブロックキャッシュ
  if (url === PMTILES_URL) {
    event.respondWith(handlePmtiles(req));
    return;
  }
  // 2) スタイル / グリフ / スプライト、MapLibre CSS -> Cache API (cache-first)
  if (url.startsWith(ASSET_PREFIX) || url === MAPLIBRE_CSS) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // 3) アプリシェル(同一オリジンのナビゲーション / main.js) -> cache-first + オフラインフォールバック
  const isSameOrigin = new URL(req.url).origin === sw.location.origin;
  if (isSameOrigin && (req.mode === "navigate" || url.endsWith("/main.js"))) {
    event.respondWith(appShell(req));
    return;
  }
  // それ以外は通常どおりブラウザに任せる
});

// -------------------- PMTiles の Range キャッシュ本体 --------------------

async function handlePmtiles(request: Request): Promise<Response> {
  const rangeHeader = request.headers.get("Range");

  // pmtiles は常に閉区間の Range(bytes=start-end)を使う。
  // それ以外(全件取得や末尾開区間)は巨大すぎるのでキャッシュせず素通し。
  const m = rangeHeader && /^bytes=(\d+)-(\d+)$/.exec(rangeHeader.trim());
  if (!m) return fetch(request);

  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  if (end < start) return fetch(request);

  // OPFS キャッシュが無効なら、読み書きせずそのままネットワークへ流す
  if (!(await loadCacheEnabled())) return fetch(request);

  try {
    const dir = await getCacheDir();

    const firstBlock = Math.floor(start / BLOCK_SIZE);
    const lastBlock = Math.floor(end / BLOCK_SIZE);

    // 必要なブロックを OPFS から読み、無いものはネットワークから補充して保存
    const blocks = await ensureBlocks(dir, firstBlock, lastBlock);

    // 要求された [start, end] をブロック群から組み立てる
    const outLen = end - start + 1;
    const out = new Uint8Array(outLen);
    for (let b = firstBlock; b <= lastBlock; b++) {
      const data = blocks.get(b);
      if (!data) continue; // EOF 越え等
      const blockStartByte = b * BLOCK_SIZE;
      const copyStart = Math.max(start, blockStartByte);
      const copyEnd = Math.min(end, blockStartByte + data.length - 1);
      if (copyEnd < copyStart) continue;
      out.set(
        data.subarray(copyStart - blockStartByte, copyEnd - blockStartByte + 1),
        copyStart - start
      );
    }

    const total = (await readTotal(dir)) ?? "*";

    return new Response(out, {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(out.length),
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "X-Cache": "OPFS",
      },
    });
  } catch (err) {
    // 何かあってもネットワークへフォールバック(地図表示を止めない)
    console.error("[sw] OPFS range cache failed, fallback to network:", err);
    return fetch(request);
  }
}

/**
 * firstBlock..lastBlock の各ブロックを並行取得して Map<blockIndex, Uint8Array> で返す。
 * 取得は acquireBlock 経由で行うため、同じブロックへの同時要求は 1 回の fetch に集約される。
 */
async function ensureBlocks(
  dir: FileSystemDirectoryHandle,
  firstBlock: number,
  lastBlock: number
): Promise<Map<number, Uint8Array>> {
  const blocks = new Map<number, Uint8Array>();
  const indices: number[] = [];
  for (let b = firstBlock; b <= lastBlock; b++) indices.push(b);

  await Promise.all(
    indices.map(async (b) => {
      const data = await acquireBlock(dir, b);
      if (data) blocks.set(b, data);
    })
  );

  return blocks;
}

// 取得中ブロックの共有 Promise。
// MapLibre は同時に多数のタイルを要求し、近接タイルが同じ PMTiles 内部範囲(=同じブロック)を
// 要求することがある。ブロック単位で「今まさに取得中」の Promise を共有することで、
// 同一ブロックの二重 fetch / 二重 write を防ぐ。
const inFlight = new Map<number, Promise<Uint8Array | null>>();

// 診断用: 実際にネットワークへ出たブロック取得の回数(dedup が効いているかの検証に使う)
let networkBlockFetches = 0;

async function acquireBlock(
  dir: FileSystemDirectoryHandle,
  idx: number
): Promise<Uint8Array | null> {
  // 1) 既に OPFS にあれば即返す
  const cached = await readBlock(dir, idx);
  if (cached) return cached;

  // 2) 同じブロックを取得中なら、その Promise に相乗りする(二重取得を防ぐ)
  const existing = inFlight.get(idx);
  if (existing) return existing;

  // 3) 自分が取得を担当する。完了するまで他の要求は (2) で待つ。
  const task = fetchAndStoreBlock(dir, idx);
  inFlight.set(idx, task);
  try {
    return await task;
  } finally {
    inFlight.delete(idx);
  }
}

async function fetchAndStoreBlock(
  dir: FileSystemDirectoryHandle,
  idx: number
): Promise<Uint8Array | null> {
  const start = idx * BLOCK_SIZE;
  const end = start + BLOCK_SIZE - 1; // 終端越えはサーバが 206 でクランプ
  networkBlockFetches++;
  const resp = await fetch(PMTILES_URL, {
    headers: { Range: `bytes=${start}-${end}` },
  });
  if (resp.status === 416) return null; // 範囲外(EOF 越え)
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`upstream range fetch failed: ${resp.status}`);
  }

  // 総サイズを学習して保存(Content-Range: bytes s-e/total)
  const cr = resp.headers.get("Content-Range");
  if (cr && cr.includes("/")) {
    const total = cr.split("/")[1].trim();
    if (total && total !== "*") await writeTotal(dir, total);
  }

  const bytes = new Uint8Array(await resp.arrayBuffer());
  await writeBlock(dir, idx, bytes);
  return bytes;
}

// -------------------- OPFS ヘルパ --------------------

async function getCacheDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

async function readBlock(
  dir: FileSystemDirectoryHandle,
  idx: number
): Promise<Uint8Array | null> {
  try {
    const fh = await dir.getFileHandle(String(idx));
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null; // 未キャッシュ
  }
}

async function writeBlock(
  dir: FileSystemDirectoryHandle,
  idx: number,
  bytes: Uint8Array
): Promise<void> {
  const fh = await dir.getFileHandle(String(idx), { create: true });
  const w = await fh.createWritable();
  // slice() で生成した Uint8Array は専用 ArrayBuffer 上にあるが、TS の型では
  // ArrayBufferLike(SharedArrayBuffer を含む)扱いになるためキャストして渡す
  await w.write(bytes as unknown as Uint8Array<ArrayBuffer>);
  await w.close();
}

// 総サイズはセッション中変わらないので一度だけ書き、以降はメモリから返す。
// (並行ブロック取得で writeTotal が多重に呼ばれても meta.json への書き込み競合を避ける)
let knownTotal: string | null = null;

async function readTotal(
  dir: FileSystemDirectoryHandle
): Promise<string | null> {
  if (knownTotal !== null) return knownTotal;
  try {
    const fh = await dir.getFileHandle("meta.json");
    const file = await fh.getFile();
    knownTotal = (JSON.parse(await file.text()) as { totalSize: string })
      .totalSize;
  } catch {
    knownTotal = null;
  }
  return knownTotal;
}

async function writeTotal(
  dir: FileSystemDirectoryHandle,
  total: string
): Promise<void> {
  if (knownTotal === total) return; // 既知なら書かない(無駄な書き込み競合を避ける)
  knownTotal = total;
  const fh = await dir.getFileHandle("meta.json", { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ totalSize: total }));
  await w.close();
}

// -------------------- 静的アセットの cache-first --------------------

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const resp = await fetch(request);
  if (resp && resp.ok) {
    cache.put(request, resp.clone()).catch(() => {});
  }
  return resp;
}

// アプリシェル: network-first。オンライン時は常に最新を取得して
// デプロイした新しいコードが確実に反映されるようにし、取得結果をキャッシュに更新する。
// オフライン時のみキャッシュ(なければプリキャッシュ済み index.html)へフォールバックする。
async function appShell(request: Request): Promise<Response> {
  const cache = await caches.open(ASSET_CACHE);
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) cache.put(request, resp.clone()).catch(() => {});
    return resp;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (request.mode === "navigate") {
      const index =
        (await cache.match("./index.html")) ?? (await cache.match("./"));
      if (index) return index;
    }
    throw err;
  }
}
