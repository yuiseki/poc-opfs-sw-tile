import { test, expect, type Page } from "@playwright/test";

const PMTILES = "planet.pmtiles";

/** OPFS の pmtiles-blocks に保存されたブロック数・合計バイト数を数える */
async function readOpfsStats(page: Page): Promise<{ count: number; bytes: number }> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      // 消去直後など存在しない場合はキャッシュ 0 とみなす
      const dir = await root.getDirectoryHandle("pmtiles-blocks");
      let count = 0;
      let bytes = 0;
      // FileSystemDirectoryHandle は [name, handle] の AsyncIterable
      for await (const [name, handle] of dir as unknown as AsyncIterable<
        [string, FileSystemHandle]
      >) {
        if (name === "meta.json" || handle.kind !== "file") continue;
        count++;
        bytes += (await (handle as FileSystemFileHandle).getFile()).size;
      }
      return { count, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  });
}

async function waitForController(page: Page): Promise<void> {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
    timeout: 20_000,
  });
}

test.describe("OPFS + Service Worker タイルキャッシュ", () => {
  test("コールドスタートで Service Worker がルートスコープで制御する", async ({ page }) => {
    await page.goto("/");
    await waitForController(page);

    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        controller: !!navigator.serviceWorker.controller,
        scope: reg?.scope ?? null,
        state: reg?.active?.state ?? null,
      };
    });

    expect(sw.controller).toBe(true);
    expect(sw.state).toBe("activated");
    expect(sw.scope).toBe("http://localhost:8080/");
  });

  test("アクセスした範囲のタイルだけが OPFS にキャッシュされる", async ({ page }) => {
    // pmtiles へのレスポンスが SW 由来(206)であることを観測
    const swResponses: number[] = [];
    page.on("response", (r) => {
      if (r.url().includes(PMTILES) && r.fromServiceWorker()) {
        swResponses.push(r.status());
      }
    });

    await page.goto("/");
    await waitForController(page);

    // タイル取得が走るのを待つ(map の "idle" 相当の安定化待ち)
    await expect
      .poll(async () => (await readOpfsStats(page)).count, { timeout: 30_000 })
      .toBeGreaterThan(0);

    const stats = await readOpfsStats(page);
    // ブロックは保存されているが、planet 全体(83GB)には遠く及ばない少量であること
    expect(stats.count).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.bytes).toBeLessThan(50 * 1024 * 1024); // 高々数十MB

    // SW が 206 を返している
    expect(swResponses.length).toBeGreaterThan(0);
    expect(swResponses.every((s) => s === 206)).toBe(true);
  });

  test("オフラインにしても OPFS から地図を復元できる", async ({ page, context }) => {
    // 1) オンラインで範囲をキャッシュ
    await page.goto("/");
    await waitForController(page);
    await expect
      .poll(async () => (await readOpfsStats(page)).count, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const before = await readOpfsStats(page);

    // 2) オフラインへ。reload してもアプリシェル + OPFS で起動できる
    await context.setOffline(true);

    await page.reload({ waitUntil: "load" });
    await waitForController(page);

    // アプリが起動し canvas が描画されている(= アプリシェルがオフラインで復元できた)
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 15_000 });

    // オフライン後もキャッシュ済みブロックは保持されている
    const after = await readOpfsStats(page);
    expect(after.count).toBeGreaterThanOrEqual(before.count);

    await context.setOffline(false);
  });

  test("チェックボックスで OPFS キャッシュを ON/OFF できる", async ({ page }) => {
    await page.goto("/");
    await waitForController(page);

    // SW 経由で Range を取得したときの X-Cache ヘッダを返す。
    // OPFS 経路を通ったときだけ "OPFS"、無効化時は素通しで null になる。
    const xCache = () =>
      page.evaluate(async () => {
        const r = await fetch(
          "https://z.yuiseki.net/static/openstreetmap/planet/planet.pmtiles",
          { headers: { Range: "bytes=0-1023" } }
        );
        return r.headers.get("X-Cache");
      });

    const toggle = page.locator("#cache-toggle");

    // 既定: ON → OPFS 経路
    await expect.poll(xCache, { timeout: 10_000 }).toBe("OPFS");

    // OFF → 素通し(X-Cache が付かない)
    await toggle.uncheck();
    await expect.poll(xCache, { timeout: 10_000 }).not.toBe("OPFS");

    // ON に戻す → 再び OPFS 経路
    await toggle.check();
    await expect.poll(xCache, { timeout: 10_000 }).toBe("OPFS");
  });

  test("リロード初回の描画時間が (初回) 付きで表示される", async ({ page }) => {
    await page.goto("/");
    await waitForController(page);

    // 操作せずとも、最初の idle で初回描画時間が表示される
    await expect
      .poll(async () => (await page.locator("#render").textContent()) ?? "", {
        timeout: 30_000,
      })
      .toMatch(/^\d+\s*ms\s*\(初回\)$/);
  });

  test("再描画(movestart→idle)の所要時間がパネルに表示される", async ({ page }) => {
    await page.goto("/");
    await waitForController(page);

    // 地図(と __map)の準備を待つ
    await page.waitForFunction(
      () => (window as unknown as { __map?: { loaded(): boolean } }).__map?.loaded(),
      null,
      { timeout: 30_000 }
    );

    // ズームインして再描画を発生させる
    await page.evaluate(() => {
      const m = (window as unknown as {
        __map: { getZoom(): number; zoomTo(z: number): void };
      }).__map;
      m.zoomTo(m.getZoom() + 2);
    });

    // "NNN ms" が表示される
    await expect
      .poll(async () => (await page.locator("#render").textContent()) ?? "", {
        timeout: 30_000,
      })
      .toMatch(/^\d+\s*ms$/);
  });

  test("SW 未制御(ハードリロード相当)でも 準備中… で固まらず起動する", async ({ page }) => {
    // controller を null 固定 & controllerchange を抑止して、
    // ハードリロード時(SW 制御対象外)の状態を再現する。
    await page.addInitScript(() => {
      const c = navigator.serviceWorker;
      try {
        Object.defineProperty(c, "controller", { get: () => null });
      } catch {
        /* 環境により失敗しても続行 */
      }
      const orig = c.addEventListener.bind(c);
      // @ts-expect-error テスト用に上書き
      c.addEventListener = (type, listener, opts) => {
        if (type === "controllerchange") return;
        return orig(type, listener as EventListener, opts);
      };
    });

    await page.goto("/");

    // 地図が初期化される(= 準備中… で止まっていない)
    await page.waitForFunction(
      () => (window as unknown as { __map?: { loaded(): boolean } }).__map?.loaded(),
      null,
      { timeout: 30_000 }
    );

    const status = (await page.locator("#status").textContent()) ?? "";
    expect(status).not.toContain("準備中");
    expect(status).toContain("未制御");
  });

  test("同一ブロックへの同時要求は 1 回の fetch に集約される (inFlight)", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForController(page);

    // SW が実際にネットワークへ出たブロック取得回数を問い合わせる
    const netCount = (): Promise<number> =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = (e) => resolve(e.data.count as number);
            navigator.serviceWorker.controller?.postMessage(
              { type: "debug-net-count" },
              [ch.port2]
            );
          })
      );

    // 地図が要求しない高オフセット領域(= 未キャッシュの単一ブロック)を選ぶ
    const RANGE = "bytes=50000000-50000100";

    // 地図のタイル読み込みが静止する(ネットワーク取得が止まる)まで待ってから計測する。
    // networkBlockFetches はグローバルなので、地図の裏での取得を巻き込まないようにする。
    let base = -1;
    for (let i = 0; i < 25; i++) {
      const c = await netCount();
      if (c === base) break; // 前回と同値 = 静止
      base = c;
      await page.waitForTimeout(400);
    }

    // 同じ未キャッシュ範囲を 10 本同時に要求する
    const results = await page.evaluate(
      async ([url, range]) => {
        const reqs = Array.from({ length: 10 }, () =>
          fetch(url, { headers: { Range: range } }).then(async (res) => {
            const buf = new Uint8Array(await res.arrayBuffer());
            return { len: buf.length, x: res.headers.get("X-Cache") };
          })
        );
        return Promise.all(reqs);
      },
      [
        "https://z.yuiseki.net/static/openstreetmap/planet/planet.pmtiles",
        RANGE,
      ] as const
    );

    // 全て OPFS 経路で同一の正しいバイト列(101 バイト)が返る
    expect(results.every((r) => r.x === "OPFS")).toBe(true);
    expect(new Set(results.map((r) => r.len)).size).toBe(1);
    expect(results[0].len).toBe(101);

    // 10 本の同時要求でも、ネットワークへ出たのは 1 回だけ(二重取得が防がれている)
    const after = await netCount();
    expect(after - base).toBe(1);
  });

  test("同時ネットワーク取得数が上限(12)を超えない", async ({ page }) => {
    await page.goto("/");
    await waitForController(page);

    const peak = (): Promise<number> =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = (e) => resolve(e.data.peak as number);
            navigator.serviceWorker.controller?.postMessage(
              { type: "debug-net-count" },
              [ch.port2]
            );
          })
      );

    // 未キャッシュの異なるブロックを 30 本同時に要求して取得を集中させる
    await page.evaluate(async () => {
      const url =
        "https://z.yuiseki.net/static/openstreetmap/planet/planet.pmtiles";
      const reqs = Array.from({ length: 30 }, (_, i) => {
        const start = 60_000_000 + i * 65536; // 各ブロックを 1 つずつずらす
        return fetch(url, { headers: { Range: `bytes=${start}-${start + 50}` } });
      });
      await Promise.all(reqs);
    });

    const p = await peak();
    // 上限を超えない。かつ実際に十分並列化されている(逐次ではない)。
    expect(p).toBeLessThanOrEqual(12);
    expect(p).toBeGreaterThanOrEqual(8);
  });

  test("二度目の同一ブロック要求はメモリキャッシュから返る (OPFS/ネットワーク不要)", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForController(page);

    const stats = (): Promise<{ count: number; memHits: number }> =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = (e) => resolve(e.data);
            navigator.serviceWorker.controller?.postMessage(
              { type: "debug-net-count" },
              [ch.port2]
            );
          })
      );

    const fetchRange = (range: string) =>
      page.evaluate(
        ([url, r]) => fetch(url, { headers: { Range: r } }).then(() => undefined),
        [
          "https://z.yuiseki.net/static/openstreetmap/planet/planet.pmtiles",
          range,
        ] as const
      );

    // 地図のタイル読み込みが静止するまで待つ(memHits はグローバルなため)
    let q = -1;
    for (let i = 0; i < 25; i++) {
      const c = (await stats()).count;
      if (c === q) break;
      q = c;
      await page.waitForTimeout(400);
    }

    // 地図が触らない高オフセットの単一ブロックを一度取得(メモリ + OPFS に載る)
    const RANGE = "bytes=61000000-61000050";
    await fetchRange(RANGE);

    const before = await stats();
    // 同じブロックをもう一度要求 -> メモリヒットし、ネットワークは増えない
    await fetchRange(RANGE);
    const after = await stats();

    expect(after.memHits - before.memHits).toBe(1); // メモリから返った
    expect(after.count - before.count).toBe(0); // ネットワーク取得は発生しない
  });

  test("キャッシュ全消去ボタンで OPFS が空になる", async ({ page }) => {
    await page.goto("/");
    await waitForController(page);
    await expect
      .poll(async () => (await readOpfsStats(page)).count, { timeout: 30_000 })
      .toBeGreaterThan(0);

    await page.getByRole("button", { name: "キャッシュを全消去" }).click();

    await expect
      .poll(async () => (await readOpfsStats(page)).count, { timeout: 10_000 })
      .toBe(0);
  });
});
