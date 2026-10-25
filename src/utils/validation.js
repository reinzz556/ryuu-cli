/**
 * Small dependency-free JSON-schema subset validator.
 *
 * Supported keywords: type, properties, required, additionalProperties,
 * enum, items, minItems, maxItems, minLength, maxLength, minimum, maximum,
 * pattern. Unknown keywords are ignored (they are documentation for the model).
 *
 * This intentionally validates only what the tool registry actually declares,
 * so there is one source of truth and no schema-library dependency.
 */

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

function typeMatches(type, value) {
  const check = TYPE_CHECKS[type];
  if (!check) return true;
  return check(value);
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * @returns {string[]} list of human-readable validation errors (empty = valid)
 */
export function validateSchema(schema, value, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) {
      errors.push(`${path}: expected ${types.join(' | ')}, received ${describeType(value)}`);
      return errors;
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((allowed) => deepEqual(allowed, value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must be at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: must be at most ${schema.maxLength} character(s)`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: must match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(schema.items, item, `${path}[${index}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null) {
        errors.push(`${path}.${key}: is required`);
      }
    }
    const properties = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) {
        errors.push(...validateSchema(properties[key], item, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: unexpected property`);
      }
    }
  }

  return errors;
}

export function assertSchema(schema, value, label = 'input') {
  const errors = validateSchema(schema, value);
  if (errors.length > 0) {
    const error = new Error(`Invalid ${label}: ${errors.join('; ')}`);
    error.code = 'VALIDATION_FAILED';
    error.validationErrors = errors;
    throw error;
  }
  return value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** Parse JSON with a useful, bounded error message (never echo huge payloads). */
export function parseJsonArguments(text, { maxLength = 20000 } = {}) {
  if (text == null || text === '') return {};
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`Tool arguments JSON is too large (${trimmed.length} bytes)`);
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error.message.startsWith('Tool arguments')) throw error;
    throw new Error(`Malformed tool arguments JSON: ${error.message}`);
  }
}

/* ------------------------------------------------------------------------- *
 * Tolerant JSON repair.
 *
 * Streamed tool-call arguments are frequently truncated mid-object (the model
 * stopped, the socket closed, or a token budget cut the payload). A truncated
 * payload used to be stored verbatim in the conversation, and the provider then
 * rejected the *next* request with
 *   `messages[n].tool_calls[i].function.arguments must be a valid JSON object
 *    string` — killing the whole task even though only one call was broken.
 *
 * The scanner below finds the longest prefix of a payload that is a valid
 * JSON value and closes the containers that were still open, so a truncated
 * call is usually still usable.
 * ------------------------------------------------------------------------- */

const LITERAL_RE = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/** Scan a JSON string literal; returns the index after the closing quote. */
function scanString(text, start) {
  let i = start + 1;
  let escaped = false;
  while (i < text.length) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      i += 1;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      i += 1;
      continue;
    }
    if (char === '"') return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * Scan a JSON value.
 * @returns {{complete: boolean, end: number, safe: {index: number, closers: string}|null}}
 */
function scanValue(text, start, depth = 0) {
  if (depth > 64) return { complete: false, end: start, safe: null };
  const i = skipWhitespace(text, start);
  if (i >= text.length) return { complete: false, end: i, safe: null };
  const char = text[i];
  if (char === '"') {
    const end = scanString(text, i);
    if (end < 0) {
      // Truncated inside the string: the value can still be recovered by
      // closing the quote at the end of the payload.
      let backslashes = 0;
      while (backslashes < text.length && text[text.length - 1 - backslashes] === '\\') backslashes += 1;
      // An odd number of trailing backslashes means the last one starts an
      // unfinished escape sequence: drop it before closing the quote.
      const index = backslashes % 2 === 1 ? text.length - 1 : text.length;
      return { complete: false, end: text.length, safe: { index, closers: '"' } };
    }
    return { complete: true, end, safe: null };
  }
  if (char === '{') return scanObject(text, i, depth);
  if (char === '[') return scanArray(text, i, depth);
  const literal = LITERAL_RE.exec(text.slice(i));
  if (literal) return { complete: true, end: i + literal[0].length, safe: null };
  return { complete: false, end: i, safe: null };
}

/**
 * Scan a JSON object.
 * `safe` is the longest prefix that is a valid JSON value once the still-open
 * containers are closed: `{ index, closers }`.
 */
function scanObject(text, start, depth) {
  let i = start + 1;
  let safe = null;
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) return { complete: false, end: i, safe };
    if (text[i] === '}') return { complete: true, end: i + 1, safe };
    if (text[i] !== '"') return { complete: false, end: i, safe };
    const keyEnd = scanString(text, i);
    if (keyEnd < 0) return { complete: false, end: i, safe };
    i = skipWhitespace(text, keyEnd);
    if (text[i] !== ':') return { complete: false, end: i, safe };
    i = skipWhitespace(text, i + 1);
    const value = scanValue(text, i, depth + 1);
    if (!value.complete) {
      // The value itself is truncated: fall back to the deepest safe point.
      const inner = value.safe;
      if (inner) return { complete: false, end: value.end, safe: { index: inner.index, closers: `${inner.closers}}` } };
      return { complete: false, end: value.end, safe };
    }
    safe = { index: value.end, closers: '}' };
    i = skipWhitespace(text, value.end);
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (text[i] === '}') return { complete: true, end: i + 1, safe };
    return { complete: false, end: i, safe };
  }
}

/** Scan a JSON array (see `scanObject`). */
function scanArray(text, start, depth) {
  let i = start + 1;
  let safe = null;
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) return { complete: false, end: i, safe };
    if (text[i] === ']') return { complete: true, end: i + 1, safe };
    const value = scanValue(text, i, depth + 1);
    if (!value.complete) {
      const inner = value.safe;
      if (inner) return { complete: false, end: value.end, safe: { index: inner.index, closers: `${inner.closers}]` } };
      return { complete: false, end: value.end, safe };
    }
    safe = { index: value.end, closers: ']' };
    i = skipWhitespace(text, value.end);
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (text[i] === ']') return { complete: true, end: i + 1, safe };
    return { complete: false, end: i, safe };
  }
}

/**
 * Repair a truncated/malformed JSON payload.
 * @returns {string|null} the repaired JSON text, or null when unrecoverable
 */
export function repairJsonText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // A markdown fence around the payload is a common model slip.
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const source = unfenced || trimmed;

  const scan = scanValue(source, 0);
  if (scan.complete) {
    // The value is complete; trailing junk after it is ignored.
    const direct = source.slice(0, scan.end);
    try {
      JSON.parse(direct);
      return direct;
    } catch {
      // A trailing comma (`{"a":1,}`) parses nowhere: retry from the safe point.
    }
  }
  const safe = scan.safe;
  if (!safe) return null;
  const candidate = `${source.slice(0, safe.index)}${safe.closers}`;
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Parse tool-call arguments without ever throwing.
 *
 * @returns {{ok: true, value: object, repaired: boolean}
 *          |{ok: false, error: string, raw: string}}
 */
export function parseToolArguments(text, { maxLength = 20000 } = {}) {
  const raw = typeof text === 'string' ? text : '';
  if (text == null || raw.trim() === '') return { ok: true, value: {}, repaired: false };
  if (typeof text !== 'string') {
    if (text && typeof text === 'object' && !Array.isArray(text)) return { ok: true, value: text, repaired: false };
    return { ok: false, error: 'Tool arguments must be a JSON object.', raw: '' };
  }
  if (raw.length > maxLength) {
    return { ok: false, error: `Tool arguments JSON is too large (${raw.length} bytes)`, raw: raw.slice(0, 400) };
  }
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Tool arguments must be a JSON object.', raw: raw.slice(0, 400) };
    }
    return { ok: true, value: parsed, repaired: false };
  } catch (error) {
    const repaired = repairJsonText(raw);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ok: true, value: parsed, repaired: true };
        }
      } catch {
        // Fall through to the error below.
      }
    }
    return {
      ok: false,
      error: `Malformed tool arguments JSON: ${error.message}`,
      raw: raw.slice(0, 400),
    };
  }
}

/**
 * Always return a valid JSON object string for a tool call.
 *
 * The provider validates `function.arguments` on every request, so a broken
 * payload must never reach the wire: repair it when possible, otherwise send
 * an empty object.
 */
export function toToolArgumentsString(text, { maxLength = 20000 } = {}) {
  const parsed = parseToolArguments(text, { maxLength });
  if (parsed.ok) return JSON.stringify(parsed.value);
  return '{}';
}
