/**
 * Conversation context management.
 *
 * Compaction is deterministic: it never invents a model-written summary.
 * It preserves the original task, current plan, tool facts (changed files,
 * commands, issues) supplied by the agent, and the most recent exchanges.
 * Assistant tool_calls are always kept together with their tool responses so
 * the provider's tool-call protocol stays valid.
 */

export function messageChars(message) {
  try {
    return JSON.stringify(message).length;
  } catch {
    return String(message?.content || '').length;
  }
}

export function conversationChars(messages) {
  return messages.reduce((total, message) => total + messageChars(message), 0);
}

/** Group messages so an assistant tool_calls message travels with its tool replies. */
export function groupMessages(messages) {
  const groups = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const group = [message];
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor].role === 'tool') {
        group.push(messages[cursor]);
        cursor += 1;
      }
      groups.push(group);
      index = cursor;
    } else {
      groups.push([message]);
      index += 1;
    }
  }
  return groups;
}

export function summarizeFacts({ task = '', plan = '', changedFiles = [], commands = [], issues = [] } = {}) {
  const lines = ['[Context compacted to fit the model window]'];
  if (task) lines.push(`Original task: ${task.slice(0, 1200)}`);
  if (plan) lines.push(`Plan: ${plan.slice(0, 1200)}`);
  if (changedFiles.length > 0) lines.push(`Files changed: ${changedFiles.slice(0, 60).join(', ')}`);
  const ran = commands.slice(-10).map((cmd) => {
    const argv = Array.isArray(cmd.argv) ? cmd.argv.join(' ') : String(cmd.argv || '');
    return `${argv} -> ${cmd.status ?? 'ran'}${cmd.exitCode !== undefined && cmd.exitCode !== null ? ` (exit ${cmd.exitCode})` : ''}`;
  });
  if (ran.length > 0) lines.push(`Commands run: ${ran.join('; ')}`);
  if (issues.length > 0) lines.push(`Outstanding issues: ${issues.slice(0, 10).join('; ')}`);
  lines.push('Earlier tool outputs were removed. Re-read files or re-run commands if exact output is needed.');
  return lines.join('\n');
}

/**
 * Trim context while preserving system prompts, the first user task, and the
 * newest complete exchange groups.
 *
 * @returns {{messages: object[], compacted: boolean, removedGroups: number}}
 */
export function compactMessages(messages, { maxChars = 120000, facts = {}, recentGroups = 8 } = {}) {
  if (conversationChars(messages) <= maxChars) {
    return { messages, compacted: false, removedGroups: 0 };
  }

  const systemMessages = messages.filter((message) => message.role === 'system');
  const body = messages.filter((message) => message.role !== 'system');
  const groups = groupMessages(body);
  const firstUserGroup = groups.find((group) => group[0]?.role === 'user');

  const keep = [];
  let used = systemMessages.reduce((total, message) => total + messageChars(message), 0);
  let removed = 0;
  // Reserve budget for the compaction note.
  const note = summarizeFacts(facts);
  const budget = Math.max(2000, maxChars - note.length - 500);

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === firstUserGroup) continue;
    const size = group.reduce((total, message) => total + messageChars(message), 0);
    const isNewest = index === groups.length - 1;
    if (!isNewest && (keep.length >= recentGroups || used + size > budget)) {
      removed += 1;
      continue;
    }
    keep.unshift(group);
    used += size;
  }
  if (firstUserGroup) {
    keep.unshift(firstUserGroup);
  }

  const compactedMessages = [
    ...systemMessages,
    { role: 'system', content: note },
    ...keep.flat(),
  ];
  return { messages: compactedMessages, compacted: removed > 0, removedGroups: removed };
}
