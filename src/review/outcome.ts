import { translate, type Locale } from './i18n.js';
import { renderReport } from './report.js';
import type { Outcome } from './runtime.js';

/**
 * 审查结局的状态标签。原先住在 code-review 插件的 index.ts 里（随 `/review` 命令一起
 * 渲染）；本项目不再注册该命令，但「代码审查专家」仍然要把同一份结局渲染成 markdown，
 * 所以把标签与渲染逻辑原样抽到这里，保证两边产物一致。
 */
const labels: Record<Outcome['status'], Parameters<typeof translate>[1]> = {
  'no-changes': '无变更',
  'completed-clean': '完成 · 零发现',
  'completed-findings': '完成 · 有发现',
  'completed-text': '完成',
  partial: '部分覆盖',
  failed: '失败',
  interrupted: '中断',
  'invalid-output': '输出无效',
  stale: '快照过期',
};

/** 把一次审查结局渲染成交给主会话的 markdown。 */
export function renderOutcome(result: Outcome, locale: Locale = 'zh'): string {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  return [
    `## ${t('代码审查')} · ${translate(locale, labels[result.status])}`,
    `${t('运行：')}\`${result.id}\``,
    result.detail,
    result.fingerprint
      ? `${t('快照：')}${result.fingerprint}\n${t('基线：')}${result.base}\n${t('目标：')}${result.target}`
      : '',
    result.report ? renderReport(result.report, locale) : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
