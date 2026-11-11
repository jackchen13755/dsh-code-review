import { readHostLocale, outputLanguage, translate, type Locale } from './i18n.js';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentActivation, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent';
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import { resolveSessionCwd } from './cwd.js';
import { reviewPrompt, type Target } from './request.js';
import { parseReport, REVIEW_PROMPT, type Report } from './report.js';

// 旧状态仅为历史报告兼容；新运行不再生成快照、过期或插件自定覆盖判断。
export type Status = 'no-changes' | 'completed-clean' | 'completed-findings' | 'completed-text' | 'partial' | 'failed' | 'interrupted' | 'invalid-output' | 'stale';
export interface Outcome { id: string; status: Status; detail: string; fingerprint?: string; base?: string; target?: string; report?: Report; raw?: string }
// 与 Agency 专家一致：角色由 provider 组合，禁止递归召唤专家，权限由宿主委派。
// `dsh_code_review` 必须在这里：它 2026-11-11 重新注册为模型工具（用户选择 A 路线），
// 评审子 Agent 继承主会话工具面，若不 deny 就会出现「审查子 Agent 再调审查」的自激环，
// 也就是用户明确要求杜绝的「评审里触发评审 → 无限循环」。
// 注意 `ctx.tools.get` 过滤器（下方 :deny 计算）会在工具不存在时自动剔除该名字。
const delegatedTools = ['summon_expert', 'summon_experts', 'list_experts', 'list_expert_teams', 'get_expert_team', 'summon_expert_team', 'dsh_code_review'];

function formatAbortReason(reason: unknown, locale: Locale = 'zh'): string {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  if (reason instanceof Error) {
    if (reason.name === 'AbortError' || reason.message === 'This operation was aborted') return t('操作已中止。');
    if (reason.name === 'TimeoutError' || /timed?\s*out/i.test(reason.message)) return t('操作超时。');
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    if (reason === 'This operation was aborted') return t('操作已中止。');
    return reason.trim();
  }
  if (typeof reason === 'object' && reason !== null) {
    const obj = reason as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim();
    if (typeof obj.kind === 'string') {
      if (obj.kind === 'user') return t('用户已取消操作。');
      if (obj.kind === 'parent') return t('父级任务已取消。');
      if (obj.kind === 'disposed') return t('会话已销毁。');
      if (obj.kind === 'hook') {
        const detail = typeof obj.reason === 'string' && obj.reason.trim() ? (locale === 'en' ? `: ${obj.reason.trim()}` : `：${obj.reason.trim()}`) : '';
        return `${t('操作已中止')}${detail}${detail ? '' : t('。')}`;
      }
      return `${t('操作已中止。')} (${obj.kind})`;
    }
  }
  return t('操作已中止。');
}

function abortError(signal: AbortSignal, locale: Locale = 'zh'): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    if (reason.name === 'AbortError' || reason.message === 'This operation was aborted') {
      return Object.assign(new Error(formatAbortReason(reason, locale)), { name: 'AbortError' });
    }
    return reason;
  }
  return Object.assign(new Error(formatAbortReason(reason, locale)), { name: 'AbortError' });
}

/** 等待 activation 结果；调用方 abort 时立即失败并 fire-and-forget dispose，避免与未协作的 LLM stream 死锁。 */
function awaitActivationResult(activation: SubagentActivation, signal: AbortSignal, locale: Locale = 'zh'): Promise<SubagentResult> {
  if (signal.aborted) {
    void activation.dispose();
    return Promise.reject(abortError(signal, locale));
  }
  return new Promise<SubagentResult>((resolve, reject) => {
    const onAbort = () => {
      void activation.dispose();
      reject(abortError(signal, locale));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    activation.result.then(
      (result) => { signal.removeEventListener('abort', onAbort); resolve(result); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/** 0.2.1-rc.1 之前的启动请求（如 0.2.0-rc.1 / 0.2.0-rc.2）。必须在服务对象上调用，不能拆出裸函数。 */
interface LegacySubagents {
  start(name: string, request: {
    parent: Agent; label: string; signal: AbortSignal; persona: string;
    agentOptions?: { model: string }; toolFilter: { deny: string[] };
    prompt: Array<{ type: 'text'; text: string }>;
  }): Promise<SubagentRun>;
}

/**
 * 原生 spawn 独立历史；只发送短任务，Git 和代码检查由子 Agent 自行完成。
 * 有 `startActivation` 时走 0.2.1-rc.1：角色与工具过滤在子 Agent `agent/created` 时恢复。
 * 0.2.0-rc 等没有该方法时回退到 `start` 加启动期 `persona` / `toolFilter`。
 */
export async function runReview(ctx: Context, parent: Agent, target: Target, signal: AbortSignal, timeoutMs?: number, reviewModel?: string, locale: Locale = readHostLocale(ctx), cwdOverride?: string): Promise<Outcome> {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const id = randomUUID();
  const combined = timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let activation: SubagentActivation | undefined;
  let legacyRun: SubagentRun | undefined;
  let outcome: Outcome = { id, status: 'failed', detail: t('审查未完成。') };
  let abortedEarly = false;
  try {
    // 自研修复：实时目录优先；调用方可显式指定（--cwd），用于「会话在 A、改动在 B」的场景。
    const cwd = cwdOverride ?? (await resolveSessionCwd(ctx, parent, combined));
    if (!cwd) throw new Error(t('会话没有有效 cwd。'));
    const prompt = await reviewPrompt(target, cwd, combined, locale);
    const provider = ctx.subagents.getProvider('spawn');
    if (!provider || provider.inheritsParentContext) throw new Error(t('需要独立上下文的原生 spawn provider。'));
    const persona = `${REVIEW_PROMPT}\n\n${outputLanguage(locale)}`;
    // 自研修复：按**全局可见性**过滤，而不是父会话可见性。
    // 上游用 `ctx.tools.get(name, parent)`：父被限制时名单会塌缩，审查子反而拿到专家工具
    // （递归环的入口）；但也不能无条件 deny——工具不存在时 `restrict()` 会直接抛错。
    const deny = delegatedTools.filter(name => ctx.tools.get(name) !== undefined);
    const subagents = ctx.subagents as typeof ctx.subagents & Partial<LegacySubagents>;
    let result: SubagentResult;
    if (typeof subagents.startActivation === 'function') {
      const childId = SessionId(randomUUID());
      const stop = ctx.on('agent/created', ({ agent }) => {
        if (agent.id !== childId) return undefined;
        agent.ctx.systemPrompt.section({
          name: PERSONA_PREFIX_SECTION,
          order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          text: persona,
        });
        if (deny.length) agent.ctx.tools.restrict({ deny });
        return undefined;
      });
      try {
        activation = await subagents.startActivation({
          provider: 'spawn',
          label: t('代码审查'),
          childId,
          request: {
            parent,
            // 关键：把**要审的那棵树**作为子 Agent 的初始目录传下去。
            // 不传就继承父会话目录——而父会话常常不是 git 仓库（例如一个装着多个
            // 仓库的工作区根），于是审查子 Agent 在错误的目录里跑 git diff，
            // 表现为「审的是主区域 / 什么都审不到」。提示词里不放目录是有意的：
            // 短任务文本与 codex-rs 逐字对齐，靠 cwd 而不是靠自然语言指令定位仓库。
            cwd,
            prompt: [{ type: 'text', text: prompt }],
            ...(reviewModel ? { agentOptions: { model: reviewModel } } : {}),
          },
          signal: combined,
          delivery: 'caller',
        });
      } finally {
        stop();
      }
      result = await awaitActivationResult(activation, combined, locale);
    } else {
      const capabilities = provider.capabilities as { persona?: boolean; toolFilter?: boolean };
      if (!capabilities.persona || !capabilities.toolFilter || typeof subagents.start !== 'function') throw new Error(t('需要独立上下文的原生 spawn provider。'));
      legacyRun = await subagents.start('spawn', {
        parent, label: t('代码审查'), signal: combined, persona,
        ...(reviewModel ? { agentOptions: { model: reviewModel } } : {}),
        // 注意：旧版 start('spawn', …) 的请求形状**不接受 cwd**（类型里就没有这个字段，
        // startActivation 那条才有）。这里不写 `as any` 强塞一个运行期会被忽略的字段——
        // 那只会让人误以为旧宿主也修好了。旧宿主仍继承父会话目录，即已知能力缺口。
        toolFilter: { deny },
        prompt: [{ type: 'text', text: prompt }],
      });
      result = await legacyRun.result;
    }
    combined.throwIfAborted();
    if (result.stopReason !== 'completed') throw new Error(`${t('原生子 Agent 未完成：')}${result.stopReason}${result.diagnostic ? ` ${result.diagnostic}` : ''}`);
    const raw = result.output.filter(b => b.type === 'text').map(b => b.text).join('');
    if (!raw.trim()) throw new Error(t('审查 Agent 未返回报告。'));
    const report = parseReport(raw, locale);
    outcome = { id, status: report.format === 'text' ? 'completed-text' : report.findings.length ? 'completed-findings' : 'completed-clean',
      detail: t('审查完成。'), report };
  } catch (error) {
    abortedEarly = combined.aborted;
    let detail = combined.aborted
      ? formatAbortReason(combined.reason, locale)
      : (error instanceof Error ? error.message : formatAbortReason(error, locale));
    const isDomAbort = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || (typeof DOMException !== 'undefined' && error instanceof DOMException));
    if (combined.aborted && error instanceof Error && !isDomAbort && error.message && error.message !== detail) {
      detail = `${detail} (${error.message})`;
    }
    outcome = { ...outcome, status: combined.aborted ? 'interrupted' : 'failed', detail };
  } finally {
    const handle = activation ?? legacyRun;
    if (handle) {
      try {
        if (activation && abortedEarly) {
          // 中断时 dispose 可能等 LLM；限时等待以便夹具看到无残留，超时则放行。
          await Promise.race([
            handle.dispose(),
            new Promise<void>(resolve => setTimeout(resolve, 2000)),
          ]);
        } else {
          await handle.dispose();
        }
      } catch (error) {
        if (!activation || !abortedEarly) outcome = { ...outcome, status: 'failed', detail: `${t('Agent 清理失败：')}${String(error)}` };
      }
    }
  }
  return outcome;
}
