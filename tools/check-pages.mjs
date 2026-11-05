/**
 * GitHub Pages の配信が止まる種を、プッシュ前に見つける。
 *
 *   npm run check
 *
 * なぜ要るのか：2026-11-05 に docs/LINE-REMINDER.md へ波括弧を 2 つ続けて
 * 書いたせいで Pages のビルドが落ち、**サイト全体の配信が 2 週間ぶん
 * 止まっていた**。員工頁に新しい欄が出ないのも、前端のセキュリティ修正が
 * 届かないのも、原因はぜんぶそれ。しかも GitHub の画面を見に行かないと
 * 落ちたことに気づけない（push は成功するので手元は静か）。
 *
 * 見るのは 2 つ：
 *   1. .nojekyll があるか           … これがあれば Jekyll は走らない（本命の防波堤）
 *   2. raw で囲っていない Liquid の記号 … .nojekyll を外したときに効く保険
 *
 * 1 がある限り 2 は実際には無害なので、2 は「警告」で止める。
 * 1 が無くなった瞬間に 2 は「失敗」に変わる。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// このファイル自身に波括弧 2 つを直書きすると、Jekyll が走る設定に戻した
// ときに自分が引っかかる。だから文字を組み立てて持つ。
const OPEN_VAR = '{' + '{';
const OPEN_TAG = '{' + '%';
const RAW_OPEN = /\{%-?\s*raw\s*-?%\}/;
const RAW_CLOSE = /\{%-?\s*endraw\s*-?%\}/;
const RAW_TAGS = /\{%-?\s*(raw|endraw)\s*-?%\}/g;

const jekyllDisabled = existsSync('.nojekyll');

/** 追跡中の .md / .html（Jekyll がページとして扱うのはこの 2 種） */
function trackedPages() {
  const out = execFileSync('git', ['ls-files', '*.md', '*.html'], { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * raw ブロックの外に Liquid の開始記号が残っている行を返す。
 * raw は行をまたいで開きっぱなしにできるので、1 文字ずつ状態を持って歩く。
 */
function findBareLiquid(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const hits = [];
  let inRaw = false;

  lines.forEach((line, i) => {
    let pos = 0;
    while (pos < line.length) {
      if (!inRaw) {
        const m = RAW_OPEN.exec(line.slice(pos));
        const end = m ? pos + m.index : line.length;
        const segment = line.slice(pos, end).replace(RAW_TAGS, '');
        if (segment.includes(OPEN_VAR) || segment.includes(OPEN_TAG)) {
          hits.push({ line: i + 1, text: line.trim() });
        }
        if (m) { inRaw = true; pos = pos + m.index + m[0].length; } else { pos = line.length; }
      } else {
        const m = RAW_CLOSE.exec(line.slice(pos));
        if (m) { inRaw = false; pos = pos + m.index + m[0].length; } else { pos = line.length; }
      }
    }
  });

  if (inRaw) hits.push({ line: lines.length, text: 'raw ブロックが閉じられていない' });
  return hits;
}

const pages = trackedPages();
const problems = [];
for (const path of pages) {
  for (const hit of findBareLiquid(path)) problems.push({ path, ...hit });
}

let failed = false;

if (jekyllDisabled) {
  console.log('✓ .nojekyll あり（Pages は Jekyll を通さず、ファイルをそのまま配る）');
} else {
  console.log('✗ .nojekyll が無い！');
  console.log('  Jekyll が走るので、docs の波括弧 2 つでサイト全体の配信が止まる。');
  console.log('  意図して外したのでなければ、空ファイルで戻すこと：touch .nojekyll');
  failed = true;
}

if (problems.length === 0) {
  console.log(`✓ raw で囲っていない Liquid の記号なし（.md / .html を ${pages.length} 個）`);
} else {
  const label = jekyllDisabled ? '⚠ 警告' : '✗ 失敗';
  console.log(`${label}: raw で囲っていない Liquid の記号がある`);
  for (const p of problems) console.log(`    ${p.path}:${p.line}  ${p.text}`);
  console.log('  囲い方： {% raw %} …そのまま出したい文… {% endraw %}');
  if (jekyllDisabled) {
    console.log('  いまは .nojekyll があるので実害なし。外すなら先にここを直すこと。');
  } else {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
