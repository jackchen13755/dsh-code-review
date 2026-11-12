import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUBRIC_RELATIVE = join('assets', 'codex', 'review', 'rubric.md');

/**
 * 读取与 codex-rs 对齐的审查 rubric 原文（不追加快照、字段扩展或范围限制）。
 *
 * 为什么不写死一个相对路径：同一个模块会在两种布局下被执行——打包后是
 * `lib/src-*.js`（上一层即仓库根），而 Vitest 直接跑源码时是
 * `src/review/prompt.ts`（要上两层）。写死任一种都会在另一种布局里解析到错误位置，
 * 而且失败点在模块初始化（import 即崩），所以这里改成向上逐级命中即用。
 */
function readRubric(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, RUBRIC_RELATIVE);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到审查 rubric：${RUBRIC_RELATIVE}（自 ${import.meta.url} 向上 6 层未命中）`);
}

export const CODEX_REVIEW_PROMPT = readRubric();
export const REVIEW_PROMPT = CODEX_REVIEW_PROMPT;
