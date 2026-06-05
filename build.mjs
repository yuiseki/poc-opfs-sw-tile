// esbuild で TypeScript を 2 つのバンドルにビルドする。
//   src/main.ts -> docs/main.js (ESM, ページ用。maplibre-gl / pmtiles を同梱)
//   src/sw.ts   -> docs/sw.js   (IIFE, Service Worker 用。docs 直下に置く)
//
// 出力先は docs/ で、GitHub Pages がそのまま配信できるよう成果物もコミットする。
//
//   ビルド   : node build.mjs
//   監視     : node build.mjs --watch
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  target: "es2022",
  logLevel: "info",
  minify: true,
};

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
  { ...shared, entryPoints: ["src/main.ts"], outfile: "docs/main.js", format: "esm" },
  { ...shared, entryPoints: ["src/sw.ts"], outfile: "docs/sw.js", format: "iife" },
];

if (watch) {
  for (const cfg of configs) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  }
  console.log("watching… (Ctrl+C で終了)");
} else {
  await Promise.all(configs.map((cfg) => esbuild.build(cfg)));
  console.log("build done: main.js, sw.js");
}
