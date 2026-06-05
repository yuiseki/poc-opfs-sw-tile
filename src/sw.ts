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
  const data = event.data as {
    type?: string;
    enabled?: boolean;
    idx?: number;
  } | null;
  if (data?.type === "set-cache") {
    event.waitUntil(saveCacheEnabled(!!data.enabled));
  } else if (data?.type === "debug-net-count") {
    // 診断用: 各種カウンタを返す
    const port = event.ports[0];
    event.waitUntil(
      (async () => {
        const known = cachedBlocksPromise ? await cachedBlocksPromise : null;
        port?.postMessage({
          count: networkBlockFetches,
          peak: peakConcurrentFetches,
          memHits,
          opfsReads,
          cachedBlocks: known ? known.size : 0,
        });
      })()
    );
  } else if (data?.type === "debug-has-block") {
    // 診断用: 指定ブロックが索引(cachedBlocks)と OPFS 実体に存在するかを返す
    const idx = data.idx as number;
    const port = event.ports[0];
    event.waitUntil(
      (async () => {
        const known = cachedBlocksPromise ? await cachedBlocksPromise : null;
        const inSet = known ? known.has(idx) : false;
        let onDisk = false;
        try {
          const dir = await getCacheDir();
          await dir.getFileHandle(String(idx));
          onDisk = true;
        } catch {
          onDisk = false;
        }
        port?.postMessage({ inSet, onDisk });
      })()
    );
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

    const total = await getTotal(dir);

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

// Service Worker が生きている間だけ有効なメモリ内ブロックキャッシュ(簡易 LRU)。
// OPFS の getFileHandle→getFile→arrayBuffer を毎回辿らずに済むので、ホットな
// ブロック(ヘッダ・ディレクトリ・近接タイル)の再読み出しが速くなる。
const memBlocks = new Map<number, Uint8Array>();
const MEM_MAX_BLOCKS = 512; // 64KiB * 512 = 32MiB
let memHits = 0; // 診断用

function getMemBlock(idx: number): Uint8Array | undefined {
  const v = memBlocks.get(idx);
  if (!v) return undefined;
  // 簡易 LRU: 参照したら末尾へ入れ直して「最近使用」にする
  memBlocks.delete(idx);
  memBlocks.set(idx, v);
  memHits++;
  return v;
}

function putMemBlock(idx: number, data: Uint8Array): void {
  if (memBlocks.has(idx)) memBlocks.delete(idx);
  memBlocks.set(idx, data);
  while (memBlocks.size > MEM_MAX_BLOCKS) {
    const oldest = memBlocks.keys().next().value; // 先頭 = 最古
    if (oldest === undefined) break;
    memBlocks.delete(oldest);
  }
}

// OPFS に存在するブロック番号の索引。起動後に一度だけディレクトリを走査して作る。
// これにより、未キャッシュブロックで getFileHandle が毎回 reject する経路を避けられ、
// 「存在しない」判定が Set の参照だけで済む。
let cachedBlocksPromise: Promise<Set<number>> | null = null;

function getCachedBlocks(dir: FileSystemDirectoryHandle): Promise<Set<number>> {
  if (!cachedBlocksPromise) cachedBlocksPromise = scanCachedBlocks(dir);
  return cachedBlocksPromise;
}

async function scanCachedBlocks(
  dir: FileSystemDirectoryHandle
): Promise<Set<number>> {
  const set = new Set<number>();
  for await (const [name, handle] of dir as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (handle.kind === "file" && /^\d+$/.test(name)) set.add(Number(name));
  }
  return set;
}

// 診断用: 実際にネットワークへ出たブロック取得の回数(dedup が効いているかの検証に使う)
let networkBlockFetches = 0;
// 診断用: OPFS への読み取りを試みた回数(索引でスキップできているかの検証に使う)
let opfsReads = 0;

// 同時に走るネットワーク取得の上限。MapLibre は多数のタイルを一斉に要求するため、
// 上限を設けないと上流リクエストと OPFS 書き込みが一気に集中する。8〜16 が目安。
const MAX_CONCURRENT_FETCHES = 12;
let activeFetches = 0;
let peakConcurrentFetches = 0; // 診断用: 観測された同時取得数の最大
const fetchWaiters: Array<() => void> = [];

async function acquireFetchSlot(): Promise<void> {
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches++;
  } else {
    // 空きが出るまで待つ。スロットは releaseFetchSlot から引き継ぐ(カウント据え置き)。
    await new Promise<void>((resolve) => fetchWaiters.push(resolve));
  }
  if (activeFetches > peakConcurrentFetches) peakConcurrentFetches = activeFetches;
}

function releaseFetchSlot(): void {
  const next = fetchWaiters.shift();
  if (next) next(); // 待機者へスロットを引き継ぐ(activeFetches は減らさない)
  else activeFetches--;
}

async function acquireBlock(
  dir: FileSystemDirectoryHandle,
  idx: number
): Promise<Uint8Array | null> {
  // 0) メモリキャッシュにあれば最速で返す(OPFS アクセスを省略)
  const mem = getMemBlock(idx);
  if (mem) return mem;

  // 1) 索引に存在するブロックだけ OPFS から読む(未キャッシュは読み取りを試みない)
  const known = await getCachedBlocks(dir);
  if (known.has(idx)) {
    const cached = await readBlock(dir, idx);
    if (cached) {
      putMemBlock(idx, cached);
      return cached;
    }
    // 索引にはあるが実体が無い(消去された等) -> 整合を取り、取得し直す
    known.delete(idx);
  }

  // 2) 同じブロックを取得中なら、その Promise に相乗りする(二重取得を防ぐ)
  const existing = inFlight.get(idx);
  if (existing) return existing;

  // 3) 自分が取得を担当する。完了するまで他の要求は (2) で待つ。
  //    inFlight への登録は同期的に行い(相乗りを成立させる)、実 fetch は
  //    同時実行数の上限(セマフォ)内で走らせる。
  const task = (async () => {
    await acquireFetchSlot();
    try {
      return await fetchAndStoreBlock(dir, idx);
    } finally {
      releaseFetchSlot();
    }
  })();
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

  // 総サイズを学習(メモリ即時更新 / OPFS 永続化は待たない)
  const cr = resp.headers.get("Content-Range");
  if (cr && cr.includes("/")) {
    const total = cr.split("/")[1].trim();
    if (total && total !== "*") setTotal(dir, total);
  }

  const bytes = new Uint8Array(await resp.arrayBuffer());
  await writeBlock(dir, idx, bytes);
  putMemBlock(idx, bytes); // 取得直後の再要求に備えてメモリにも載せる
  (await getCachedBlocks(dir)).add(idx); // 索引にも反映
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
  opfsReads++;
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

// PMTiles の総バイト数(Content-Range の組み立て用)。セッション中は変わらないので
// 一度分かればメモリ変数に保持し、Range レスポンスのたびに OPFS を読まない。
let totalSizeCache: string | null = null;

// レスポンス経路で使う: メモリにあれば即返し、無ければ OPFS から一度だけ読む。
async function getTotal(dir: FileSystemDirectoryHandle): Promise<string> {
  if (totalSizeCache !== null) return totalSizeCache;
  try {
    const fh = await dir.getFileHandle("meta.json");
    const file = await fh.getFile();
    totalSizeCache = (JSON.parse(await file.text()) as { totalSize: string })
      .totalSize;
  } catch {
    /* 未学習。"*" を返すがキャッシュは汚さない(後で setTotal が入れる) */
  }
  return totalSizeCache ?? "*";
}

// 総サイズを学習: メモリは即時更新し、OPFS への永続化は待たない(レスポンスを止めない)。
function setTotal(dir: FileSystemDirectoryHandle, total: string): void {
  if (totalSizeCache === total) return; // 既知なら何もしない(重複書き込みも防ぐ)
  totalSizeCache = total;
  void persistTotal(dir, total); // fire-and-forget(失敗してもメモリ値で動作)
}

async function persistTotal(
  dir: FileSystemDirectoryHandle,
  total: string
): Promise<void> {
  try {
    const fh = await dir.getFileHandle("meta.json", { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify({ totalSize: total }));
    await w.close();
  } catch {
    /* 永続化失敗は無視(次回取得時に再学習される) */
  }
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
