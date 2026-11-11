import { readHostLocale, translate, outputLanguage } from './i18n.js';
import { HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm';
import { selectTarget } from './selection.js';
import { extractCwdOption } from './cwd.js';
import { runReview } from './runtime.js';
import { renderReport } from './report.js';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { Journal } from './journal.js';
/** V4 拒绝共享的 `plugin` 来源；用户消息使用插件自己的 kind。 */
const reviewRequestSource = { kind: 'michengai-code-review' };
export const name = 'dsh-code-review-fork';
export const inject = ['commands', 'subagents', 'agents', 'tools', 'systemPrompt', 'sessions', 'userQuestions'];
const labels = { 'no-changes': '无变更', 'completed-clean': '完成 · 零发现', 'completed-findings': '完成 · 有发现', 'completed-text': '完成', partial: '部分覆盖', failed: '失败', interrupted: '中断', 'invalid-output': '输出无效', stale: '快照过期' };
export function renderOutcome(result, locale = 'zh') {
    const t = (key) => translate(locale, key);
    return [`## ${t('代码审查')} · ${translate(locale, labels[result.status])}`, `${t('运行：')}\`${result.id}\``, result.detail,
        result.fingerprint ? `${t('快照：')}${result.fingerprint}\n${t('基线：')}${result.base}\n${t('目标：')}${result.target}` : '', result.report ? renderReport(result.report, locale) : ''].filter(Boolean).join('\n\n');
}
/** 命令秒级返回并在后台委派原生子 Agent 执行审查，完成后把报告作为会话消息交付。 */
export function apply(ctx, config = {}) {
    const t = (key) => translate(readHostLocale(ctx), key);
    if (config.reportDirectory !== undefined && !isAbsolute(config.reportDirectory))
        throw new Error(t('reportDirectory 必须为绝对路径。'));
    if (config.reviewModel !== undefined && !config.reviewModel.trim())
        throw new Error(t('reviewModel 不能为空。'));
    const journal = new Journal(config.reportDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'code-review'));
    const lifetime = new AbortController();
    const active = new Map();
    const operations = new Set();
    ctx.effect(() => async () => { lifetime.abort(); await Promise.allSettled([...operations]); });
    ctx.commands.register({ name: 'review-cancel', description: t('取消当前代码审查'), handler({ agent }) {
            active.get(agent.id)?.abort();
            return { kind: 'success', text: active.has(agent.id) ? t('已请求取消，等待审查清理完成。') : t('没有正在运行的审查。') };
        } });
    ctx.commands.register({ name: 'review-status', description: t('查看最近代码审查报告'), async handler({ agent }) {
            try {
                const record = await journal.read(agent.id, readHostLocale(ctx));
                return { kind: 'success', text: active.has(agent.id) ? t('审查或范围选择进行中。') : record?.state === 'running' ? t('审查中断：存在启动记录但没有完成报告，请重新运行。') : record?.state === 'finished' ? renderOutcome(record.result, readHostLocale(ctx)) : t('没有已保存的审查结果。') };
            }
            catch (error) {
                return { kind: 'error', text: `${t('审查记录读取失败：')}${String(error)}` };
            }
        } });
    function deliverReport(agent, text, locale) {
        if (lifetime.signal.aborted)
            return;
        try {
            agent.followup(createUserMessage({
                content: [{ type: 'text', text: `Here is the completed code review report:\n\n${text}\n\nPresent this report directly to the user verbatim without adding, removing, or rewriting findings. Do not attempt to fix code or perform another review. ${outputLanguage(locale)}` }],
                source: reviewRequestSource,
            }));
        }
        catch { /* session disposed or unavailable */ }
    }
    function deliverError(agent, error, locale) {
        if (lifetime.signal.aborted)
            return;
        const text = error instanceof HarnessError ? error.message : `${translate(locale, '审查未完成。')}\n\n${error instanceof Error ? error.message : String(error)}`;
        try {
            agent.followup(createUserMessage({
                content: [{ type: 'text', text: `The code review did not complete:\n\n${text}\n\nPresent this status directly to the user verbatim without retrying. ${outputLanguage(locale)}` }],
                source: reviewRequestSource,
            }));
        }
        catch { /* session disposed or unavailable */ }
    }
    ctx.commands.register({ name: 'review', description: t('选择范围或输入自定义要求'), input: { hint: t('留空提交以选择范围；或输入完整的自定义审查要求') },
        async handler(invocation) {
            const { agent, rawInput, signal } = invocation;
            const locale = readHostLocale(ctx);
            if (active.has(agent.id)) {
                return { kind: 'error', text: translate(locale, '当前会话已有审查运行，请等待或 /review-cancel。') };
            }
            const operation = review(agent, rawInput.trim(), signal);
            operations.add(operation);
            void operation
                .then(text => { deliverReport(agent, text, locale); }, error => { deliverError(agent, error, locale); })
                .finally(() => operations.delete(operation));
            return { kind: 'success', text: translate(locale, '已将审查请求提交到当前会话，将通过原生子 Agent 执行。') };
        } });
    // ---- 模型可调用评审工具（2026-11-11 恢复，用户选定 A 路线）-------------------
    //
    // 历史：I010（提交 1932bda）刻意删除本工具，理由是 Issue #3「Agent 会自动触发
    // review」+ 对齐 Codex 的 disable-model-invocation。现在用户明确要求让 agent
    // 也能触发，于是恢复——但**不靠模型自觉**，而靠三条硬约束兜住当初的问题：
    //
    //  1. 递归：审查子 Agent 拿不到本工具（runtime.ts 的 delegatedTools deny），
    //     否则「评审里再评审」就是自激环，即用户点名要杜绝的无限循环。
    //  2. 单飞：与 /review 共用 `active` Map，同会话不可能并发两份评审。
    //  3. 失败即抛：failed/interrupted/invalid-output/stale 仍抛 HarnessError，
    //     门禁据此判「调了但失败」，不会被当成评审通过（假绿）。
    //
    // 与 /review 的差别只有投递方式：工具把报告作为**工具结果**返回，模型当场
    // 能读能改；命令走 agent.followup 后台投递，不冻结输入框。两条路不同时走，
    // 避免同一份报告被投递两次。
    //
    // 必须用 defineTool 包装，且 parameters 是「字段名 → 字段描述」的扁平映射，
    // 不是 JSON Schema 的 {type:'object',properties}——裸对象在当前宿主上注册不成功
    // （dsh-review-gate/lib/index.js:280 记录了这个用真实故障换来的教训）。
    if (ctx.tools && typeof ctx.tools.register === 'function' && typeof ctx.effect === 'function') {
        const reviewTool = defineTool({
            name: 'dsh_code_review',
            description: '对当前会话未提交的改动跑一次独立代码审查（Codex 规范，由原生子 Agent 执行），返回完整报告。'
                + '这是一次性终态工具：同一轮里失败或中断就直接如实报告，不要自动重试。'
                + 'input 为空字符串时通过原生问题选择审查范围；非空时整段作为自定义审查要求，不解析 CLI 选项。'
                + '需要指定别的工作树时用 /review --cwd <绝对路径> 命令，本工具不接受目录参数。',
            parameters: {
                input: { type: 'string', description: '空字符串＝打开范围选择；非空＝完整的自定义审查要求，保留原文。' },
            },
            output: {
                schema: { type: 'object', additionalProperties: true, properties: { report: { type: 'string' } } },
                render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '') }],
            },
            async execute(args, exec) {
                const agent = exec.agent;
                if (!agent)
                    throw new Error(t('代码审查必须从当前会话调用。'));
                const input = args.input;
                if (typeof input !== 'string')
                    throw new Error(t('input 必须是字符串。'));
                const operation = review(agent, input, exec.signal);
                operations.add(operation);
                void operation.then(() => operations.delete(operation), () => operations.delete(operation));
                return { report: await operation };
            },
        });
        ctx.effect(() => ctx.tools.register(reviewTool));
    }
    async function review(agent, input, signal) {
        // 自研扩展：`/review --cwd <path> ...` 显式指定要审的工作树。
        const { cwd: cwdOverride, rest } = extractCwdOption(input);
        const locale = readHostLocale(ctx);
        const t = (key) => translate(locale, key);
        if (active.has(agent.id))
            throw new Error(t('当前会话已有审查运行，请等待或 /review-cancel。'));
        const controller = new AbortController();
        active.set(agent.id, controller);
        let started = false;
        try {
            const combined = AbortSignal.any([controller.signal, lifetime.signal, signal]);
            const target = await selectTarget(ctx, agent, rest, combined, locale, cwdOverride);
            combined.throwIfAborted();
            try {
                await journal.write(agent.id, { version: 1, state: 'running', commandId: 'review' }, locale);
                started = true;
                await ctx.sessions.flush(agent.session);
            }
            catch (error) {
                throw new Error(`${t('审查启动记录持久化失败：')}${String(error)}${t('；未调用子模型。')}`);
            }
            const result = await runReview(ctx, agent, target, combined, undefined, config.reviewModel, locale, cwdOverride);
            let durable;
            try {
                await journal.write(agent.id, { version: 1, state: 'finished', result }, locale);
                durable = await ctx.sessions.flush(agent.session);
            }
            catch (error) {
                throw new Error(`${renderOutcome(result, locale)}\n\n${t('报告持久化失败：')}${String(error)}${t('；不能确认重启后可恢复。')}`);
            }
            const text = renderOutcome(result, locale) + (durable ? '' : '\n\n' + t('宿主未配置会话持久化后端；结构化报告已独立保存。'));
            if (['failed', 'interrupted', 'invalid-output', 'stale'].includes(result.status)) {
                const code = result.status === 'interrupted' ? 'REVIEW_INTERRUPTED' : 'REVIEW_FAILED';
                throw new HarnessError(text, code);
            }
            return text;
        }
        catch (error) {
            if (started && !(error instanceof HarnessError) && error instanceof Error && (error.name === 'AbortError' || error.message === 'This operation was aborted')) {
                try {
                    const detail = t('操作已中止。');
                    await journal.write(agent.id, { version: 1, state: 'finished', result: { id: randomUUID(), status: 'interrupted', detail } }, locale);
                }
                catch { /* ignore */ }
            }
            throw error;
        }
        finally {
            active.delete(agent.id);
        }
    }
}
