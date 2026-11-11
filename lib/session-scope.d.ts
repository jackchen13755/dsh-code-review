import type { Agent } from '@deepseek-ai/dsh-agent';
export interface SessionScope {
    sessionId?: string;
    cwd: string;
    /** 最近几条用户要求，最旧在前。 */
    recentUserRequests: string[];
    /** 本会话改动的仓库（可能多个，最近改的在最前）。 */
    repos?: string[];
}
/**
 * 从会话事件里取最近几条**真实用户**要求。
 *
 * 必须排除插件自己注入的投递消息（`source.kind === 'michengai-code-review'`）：
 * 那些是上一轮评审报告的回投，把它当用户要求会让「本次审查要求」被上一份报告污染，
 * 越评越像自问自答。
 */
export declare function extractRecentUserRequests(events: unknown, limit?: number): string[];
/** 供 runtime 调用：直接从父会话收集会话上下文。 */
export declare function collectSessionScope(parent: Agent, cwd: string, repos?: string[]): SessionScope;
/**
 * 渲染成提示词块。
 *
 * 措辞要点：明确告诉审查 Agent「只评这个会话的改动」以及「同分支可能有别的会话」，
 * 否则它会把整棵树当成本次评审对象——那正是串评审的成因。
 */
export declare function sessionScopeBlock(scope: SessionScope): string;
