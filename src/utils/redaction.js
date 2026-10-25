/**
 * Secret redaction. Applied before anything is logged, persisted, or rendered
 * in an error message. Redaction is best-effort defense in depth; credentials
 * are also never read from secret files by the tools.
 */

const TOKEN_PATTERNS = [
  [/nvapi-[A-Za-z0-9._-]{6,}/g, '[REDACTED:nvidia-key]'],
  [/sk-[A-Za-z0-9._-]{6,}/g, '[REDACTED:api-key]'],
  [/\bghp_[A-Za-z0-9]{10,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, '[REDACTED:github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, '[REDACTED:slack-token]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)\s*[:=]\s*["']?)([^\s"',;}]{4,})/gi, '$1[REDACTED]'],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1[REDACTED]$2'],
];

/**
 * Build a redactor bound to a set of concrete secret values (e.g. the loaded
 * API key) plus the generic token patterns.
 */
export function createRedactor(secrets = []) {
  const values = [...new Set(secrets.filter((s) => typeof s === 'string' && s.trim().length >= 4))];
  return function redact(input) {
    if (input == null) return input;
    let text = typeof input === 'string' ? input : safeStringify(input);
    for (const value of values) {
      text = text.split(value).join('[REDACTED]');
    }
    for (const [pattern, replacement] of TOKEN_PATTERNS) {
      text = text.replace(pattern, replacement);
    }
    return text;
  };
}

const defaultRedact = createRedactor([]);

export function redact(input) {
  return defaultRedact(input);
}

/** Deep-redact strings inside plain objects/arrays; cycles become "[Circular]". */
export function redactDeep(value, seen = new WeakSet()) {
  if (typeof value === 'string') return defaultRedact(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|secret|token|api[_-]?key/i.test(key) && typeof item === 'string' && item) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactDeep(item, seen);
    }
  }
  return out;
}

/** Mask a configured secret without revealing length or characters. */
export function maskSecret(value) {
  if (!value) return '(not set)';
  return 'set (redacted)';
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? item.toString() : item));
  } catch {
    return String(value);
  }
}
