/**
 * 会话上下文块：把「这次评审属于哪个会话、用户在要求什么」写进审查提示词。
 *
 * 为什么需要：审查子 Agent 是独立会话，**拿不到父会话的任何身份**（宿主也不传）。
 * 一个分支上常常并行开好几个会话（例如「改 A 功能」和「修 B 的 bug」同时在这条分支上），
 * 而 `git diff` 看到的是同一棵树——于是评审可能对着 A 的意图去评 B 的改动，
 * 两个会话的报告也会长得一模一样、无法归属。实测中这就是「串评审」的表现。
 *
 * 所以这里显式带上三样东西：会话 id（可归属）、工作目录（可定位）、
 * 最近几条用户要求（可判断意图）。只带**摘要**，不带完整历史——
 * 完整历史会把子 Agent 的上下文塞满，也会把它拖进不该由它承担的工作区细节。
 */
/** 单条用户要求截断长度：够判断意图，又不会把提示词撑爆。 */
const PER_MESSAGE_CHARS = 300;
/** 默认取最近几条用户要求。 */
const DEFAULT_LIMIT = 3;
function textOfMessage(data) {
    if (!data || typeof data !== 'object')
        return undefined;
    const content = data.content;
    if (!Array.isArray(content))
        return undefined;
    const text = content
        .filter((block) => !!block && typeof block === 'object')
        .filter(block => block.type === 'text')
        .map(block => (typeof block.text === 'string' ? block.text : ''))
        .join('\n')
        .trim();
    return text === '' ? undefined : text;
}
/**
 * 从会话事件里取最近几条**真实用户**要求。
 *
 * 必须排除插件自己注入的投递消息（`source.kind === 'michengai-code-review'`）：
 * 那些是上一轮评审报告的回投，把它当用户要求会让「本次审查要求」被上一份报告污染，
 * 越评越像自问自答。
 */
export function extractRecentUserRequests(events, limit = DEFAULT_LIMIT) {
    const list = Array.isArray(events) ? events : [];
    const texts = [];
    for (const event of list) {
        if (!event || typeof event !== 'object')
            continue;
        if (event.type !== 'user/message')
            continue;
        const data = event.data;
        if (!data || typeof data !== 'object')
            continue;
        const source = data.source;
        if (source && typeof source === 'object') {
            const kind = source.kind;
            if (kind === 'michengai-code-review')
                continue;
        }
        const text = textOfMessage(data);
        if (!text)
            continue;
        texts.push(text.length > PER_MESSAGE_CHARS ? `${text.slice(0, PER_MESSAGE_CHARS)}…` : text);
    }
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    return texts.slice(-n);
}
/** 供 runtime 调用：直接从父会话收集会话上下文。 */
export function collectSessionScope(parent, cwd, repos) {
    let events = [];
    try {
        events = parent.session?.snapshotEvents?.() ?? [];
    }
    catch {
        events = [];
    }
    const sessionId = typeof parent.id === 'string' && parent.id !== '' ? parent.id : undefined;
    return { sessionId, cwd, recentUserRequests: extractRecentUserRequests(events), repos };
}
/**
 * 渲染成提示词块。
 *
 * 措辞要点：明确告诉审查 Agent「只评这个会话的改动」以及「同分支可能有别的会话」，
 * 否则它会把整棵树当成本次评审对象——那正是串评审的成因。
 */
export function sessionScopeBlock(scope) {
    const lines = [
        '',
        '',
        '## Session scope',
        '',
        'This review belongs to one specific session. The same branch may be shared by other',
        'sessions working on different goals, so evaluate the changes against THIS session\'s',
        'intent only. If the diff clearly contains work unrelated to the requests below, say so',
        'instead of reviewing it as part of this task.',
        '',
        `- session: ${scope.sessionId ?? 'unknown'}`,
        `- working directory: ${scope.cwd}`,
    ];
    if (scope.repos && scope.repos.length > 0) {
        lines.push(`- repositories changed by this session: ${scope.repos.join(', ')}`);
    }
    if (scope.recentUserRequests.length === 0) {
        lines.push('- recent user requests in this session: (none recorded)');
    }
    else {
        lines.push('- recent user requests in this session (oldest first):');
        scope.recentUserRequests.forEach((text, index) => {
            lines.push(`  ${index + 1}. ${text.replace(/\r?\n/g, ' ')}`);
        });
    }
    return lines.join('\n');
}
