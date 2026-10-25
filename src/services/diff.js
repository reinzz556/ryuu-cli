/**
 * Unified diff generation for edit previews and /diff.
 * Line-based LCS with a bounded matrix; very large files fall back to a
 * whole-file replacement hunk instead of consuming unbounded memory.
 */

const MAX_CELLS = 2_000_000;

function splitLines(text) {
  return String(text ?? '').split('\n');
}

/** @returns {{type: 'equal'|'del'|'add', line: string}[]} */
export function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_CELLS) {
    return [
      ...a.map((line) => ({ type: 'del', line })),
      ...b.map((line) => ({ type: 'add', line })),
    ];
  }

  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: 'del', line: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', line: b[j] });
    j += 1;
  }
  return ops;
}

/**
 * Produce a standard unified diff. Returns '' when contents are identical.
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {{oldLabel?: string, newLabel?: string, context?: number, maxLines?: number}} options
 */
export function createUnifiedDiff(oldText, newText, {
  oldLabel = 'a/file',
  newLabel = 'b/file',
  context = 3,
  maxLines = 400,
} = {}) {
  if (oldText === newText) return '';
  const ops = diffLines(oldText, newText);

  // Mark which ops are changes, then group with context.
  const changed = ops.map((op) => op.type !== 'equal');
  const hunks = [];
  let index = 0;
  while (index < ops.length) {
    if (!changed[index]) {
      index += 1;
      continue;
    }
    let start = Math.max(0, index - context);
    let end = index;
    // Extend while later changes are within 2*context of the current end.
    while (end < ops.length) {
      if (changed[end]) {
        end += 1;
        continue;
      }
      let nextChange = end;
      while (nextChange < ops.length && !changed[nextChange]) nextChange += 1;
      if (nextChange < ops.length && nextChange - end <= context * 2) {
        end = nextChange;
        continue;
      }
      break;
    }
    const hunkEnd = Math.min(ops.length, end + context);
    hunks.push({ start, end: hunkEnd });
    index = hunkEnd;
  }

  const oldLineAt = new Array(ops.length);
  const newLineAt = new Array(ops.length);
  let oldNo = 1;
  let newNo = 1;
  for (let k = 0; k < ops.length; k += 1) {
    oldLineAt[k] = oldNo;
    newLineAt[k] = newNo;
    if (ops[k].type !== 'add') oldNo += 1;
    if (ops[k].type !== 'del') newNo += 1;
  }

  const output = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  let emitted = 0;
  for (const hunk of hunks) {
    if (emitted >= maxLines) {
      output.push(`@@ diff truncated after ${maxLines} lines @@`);
      break;
    }
    const slice = ops.slice(hunk.start, hunk.end);
    const oldCount = slice.filter((op) => op.type !== 'add').length;
    const newCount = slice.filter((op) => op.type !== 'del').length;
    const oldStart = oldCount === 0 ? oldLineAt[hunk.start] - 1 : oldLineAt[hunk.start];
    const newStart = newCount === 0 ? newLineAt[hunk.start] - 1 : newLineAt[hunk.start];
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      const prefix = op.type === 'equal' ? ' ' : op.type === 'del' ? '-' : '+';
      output.push(`${prefix}${op.line}`);
      emitted += 1;
      if (emitted >= maxLines) break;
    }
  }
  return output.join('\n');
}

export function diffStats(oldText, newText) {
  const ops = diffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += 1;
    else if (op.type === 'del') removed += 1;
  }
  return { added, removed, changed: added + removed };
}
