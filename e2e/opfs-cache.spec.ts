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
