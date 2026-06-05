/**
 * ページ側スクリプト
 *  - Service Worker を登録し、確実に「制御中」にしてから地図を初期化
 *  - MapLibre + pmtiles プロトコルで planet.pmtiles を表示
 *  - OPFS に貯まったキャッシュ量を表示 / クリアする UI
 */
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

const PMTILES_OPFS_DIR = "pmtiles-blocks";
const CACHE_PREF_KEY = "opfs-cache-enabled";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const statusEl = $("status");
function setStatus(text: string, cls = ""): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}

// ---- Service Worker を確実に「制御中」にしてから地図を初期化 ----
// reload は使わない。SW 側の clients.claim() で制御が始まるまで待ってから
// 地図を初期化することで、初回アクセスでも最初の Range リクエストから横取りできる。
async function ensureServiceWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) {
    setStatus("この環境では Service Worker が使えません", "warn");
    return false;
  }
  // 既に制御下(=更新前の旧 SW が動作中)だったかを記録しておく
  const hadController = !!navigator.serviceWorker.controller;

  // 新しい SW が制御を引き継いだら(=更新時のみ)1 度だけリロードして
  // 新しい main.js / index.html を読み込む。初回アクセス(未制御→制御開始)では
  // 不要なリロードを避けるため hadController を条件にする。
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    location.reload();
  });

  // sw.js 自体は HTTP キャッシュを使わず常に更新確認する
  await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
  await navigator.serviceWorker.ready;

  if (navigator.serviceWorker.controller) return true;

  // clients.claim() による制御開始(controllerchange)を待つ。
  // ただしハードリロード時はそのページが SW の制御対象外となり
  // controllerchange が発火しない。永久待ちを避けるためタイムアウトで先へ進む
  // (この読み込みは未制御=未キャッシュだが、地図自体は表示される)。
  await new Promise<void>((resolve) => {
    const onChange = () => {
      cleanup();
      resolve();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 1500);
    const cleanup = () => {
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
  });

  return true;
}

// ---- OPFS キャッシュ ON/OFF トグル ----
// 設定は localStorage に保存し、現在制御中の SW へ postMessage で伝える。
function isCacheEnabled(): boolean {
  return localStorage.getItem(CACHE_PREF_KEY) !== "0";
}

function sendCacheState(enabled: boolean): void {
  navigator.serviceWorker.controller?.postMessage({
    type: "set-cache",
    enabled,
  });
}

function setupCacheToggle(): void {
  const toggle = $<HTMLInputElement>("cache-toggle");
  toggle.checked = isCacheEnabled();
  // 起動時点の状態を SW に同期
  sendCacheState(toggle.checked);

  toggle.addEventListener("change", () => {
    const enabled = toggle.checked;
    localStorage.setItem(CACHE_PREF_KEY, enabled ? "1" : "0");
    sendCacheState(enabled);
    setStatus(
      enabled
        ? "OPFS キャッシュ: 有効(アクセスした範囲を保存)"
        : "OPFS キャッシュ: 無効(常にネットワークへ)",
      "ok"
    );
  });
}

// ---- OPFS のキャッシュ統計を表示 ----
async function updateStats(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(PMTILES_OPFS_DIR, {
      create: true,
    });
    let count = 0;
    let bytes = 0;
    // FileSystemDirectoryHandle は AsyncIterable<[name, handle]>
    for await (const [name, handle] of dir as unknown as AsyncIterable<
      [string, FileSystemHandle]
    >) {
      if (name === "meta.json" || handle.kind !== "file") continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      count++;
      bytes += file.size;
    }
    $("blocks").textContent = count.toLocaleString();
    $("size").textContent = formatBytes(bytes);
  } catch (e) {
    console.error(e);
  }
}

async function clearCache(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root
    .removeEntry(PMTILES_OPFS_DIR, { recursive: true })
    .catch(() => {});
  await updateStats();
  setStatus("OPFS キャッシュを消去しました", "ok");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---- 地図初期化 ----
function initMap(): void {
  // pmtiles プロトコルを登録(Range リクエストは SW が横取りして OPFS にキャッシュ)
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  const styleSelect = $<HTMLSelectElement>("style");

  const map = new maplibregl.Map({
    container: "map",
    style: styleSelect.value,
    center: [139.767, 35.681], // 東京駅
    zoom: 12,
    hash: true,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  // タイルが届くたびに統計を更新(キャッシュが増える様子が見える)
  let timer: number | undefined;
  map.on("data", () => {
    clearTimeout(timer);
    timer = window.setTimeout(updateStats, 400);
  });

  // 描画完了までの時間を計測する。
  //   movestart : ズーム/パン等の操作開始
  //   moveend   : カメラの移動が止まった瞬間(スワイプやアニメーションの終了)
  //   idle      : 必要タイル全ロード + 描画完了の確定シグナル
  // 2 つの指標を出す:
  //   #render      = movestart → idle … 操作全体(スワイプ時間を含む)
  //   #render-move = moveend  → idle … 移動が止まってからの「実描画」時間
  // スマホで長くスワイプしても #render-move は実際の描画分だけになり、誤解を防ぐ。
  // 初回(リロード直後)は #render に「ナビゲーション開始 → 最初の idle」を表示。
  let gestureStart = 0;
  let lastMove = 0; // 最後にカメラが動いた時刻(move / moveend で更新)
  let measuring = false;
  let firstIdleSeen = false;

  map.on("movestart", () => {
    if (measuring) return;
    measuring = true;
    gestureStart = performance.now();
    lastMove = gestureStart;
    $("render").textContent = "計測中…";
    $("render-move").textContent = "計測中…";
  });
  // move / moveend どちらでも「最後に動いた時刻」を更新する。
  // moveend が idle より後になる環境でも、move で確実に時刻が取れる。
  map.on("move", () => {
    if (measuring) lastMove = performance.now();
  });
  map.on("moveend", () => {
    if (measuring) lastMove = performance.now();
  });
  map.on("idle", () => {
    if (measuring) {
      measuring = false;
      const now = performance.now();
      $("render").textContent = `${Math.round(now - gestureStart)} ms`;
      // 最後にカメラが動いてから描画完了まで(スワイプ時間を除いた実描画)
      $("render-move").textContent = `${Math.round(now - lastMove)} ms`;
      return;
    }
    if (!firstIdleSeen) {
      firstIdleSeen = true;
      // performance.now() はナビゲーション開始(リロード)からの経過 ms
      $("render").textContent = `${Math.round(performance.now())} ms (初回)`;
    }
  });

  styleSelect.addEventListener("change", () => {
    map.setStyle(styleSelect.value);
  });

  // デバッグ / E2E 用にマップを公開
  (window as unknown as { __map: maplibregl.Map }).__map = map;

  setStatus("準備完了。地図を動かした範囲だけが OPFS に保存されます。", "ok");
}

$("refresh").addEventListener("click", () => void updateStats());
$("clear").addEventListener("click", () => void clearCache());

// パネルの折りたたみ(タイトルをタップで開閉。スマホで地図を広く使うため)
$("panel-toggle").addEventListener("click", () => {
  $("panel").classList.toggle("collapsed");
});

void (async () => {
  const ready = await ensureServiceWorker();
  if (!ready) return;
  try {
    await navigator.storage.persist?.();
  } catch {
    /* noop */
  }
  setupCacheToggle();
  initMap();
  void updateStats();

  // ハードリロード等で SW 未制御のまま起動した場合は明示する
  // (initMap が "準備完了" をセットした後に上書き)
  if (!navigator.serviceWorker.controller) {
    setStatus(
      "SW 未制御で起動(ハードリロード?)。通常リロードでキャッシュが有効になります。",
      "warn"
    );
  }
})();

export {}; // モジュール化のため
