/**
 * Normalization for MCP tool results.
 *
 * Every provider speaks a different dialect: You.com nests results under
 * `results.web`, Firecrawl under `data.web`, Tavily under `results`, and a
 * community server may only return Markdown. The agent must never see those
 * differences, so everything is reduced to:
 *
 *   { provider, query, results: [{ title, url, snippet, content?, date? }] }
 *
 * Rules: only http(s) URLs without credentials, dedupe by canonical URL, cap
 * counts and text length, and never invent a title, snippet or source.
 */

import { SearchError } from '../../utils/errors.js';

const MAX_TITLE = 200;
const MAX_SNIPPET = 320;
const MAX_URL = 500;
const MAX_TEXT = 50000;

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Canonical URL for dedupe: lowercased host, no fragment, no trailing slash. */
export function canonicalUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    url.hash = '';
    if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch {
    return null;
  }
}

/** Pull the structured payload out of an MCP call result (or null). */
export function extractPayload(callResult) {
  if (!callResult || typeof callResult !== 'object') return null;
  if (callResult.structuredContent && typeof callResult.structuredContent === 'object') {
    return callResult.structuredContent;
  }
  for (const item of Array.isArray(callResult.content) ? callResult.content : []) {
    if (item?.type !== 'text' || typeof item.text !== 'string' || !item.text.trim()) continue;
    const text = item.text.trim();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return null;
}

/** Collect candidate result arrays from the known provider dialects. */
function candidateLists(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return [payload];
  if (typeof payload !== 'object') return [];
  const lists = [];
  const push = (value) => {
    if (Array.isArray(value)) lists.push(value);
  };
  push(payload.results);
  push(payload.results?.web);
  push(payload.results?.news);
  push(payload.web);
  push(payload.data?.web);
  push(payload.data?.results);
  push(payload.data);
  push(payload.organic);
  push(payload.organic_results);
  push(payload.items);
  push(payload.pages);
  return lists;
}

function snippetOf(item) {
  const direct = item.snippet || item.description || item.summary || item.text || item.content;
  if (typeof direct === 'string' && direct.trim()) return clean(direct, MAX_SNIPPET);
  const highlights = item.contents?.highlights || item.highlights;
  if (Array.isArray(highlights)) return clean(highlights.join(' '), MAX_SNIPPET);
  if (typeof item.markdown === 'string') return clean(item.markdown, MAX_SNIPPET);
  return null;
}

/**
 * Normalize a search payload.
 *
 * @returns {{results: object[], answer_box: object|null, people_also_ask: object[], related_searches: string[], format: string}}
 * @throws {SearchError} when the payload is not a recognizable shape
 */
export function normalizeSearchPayload(payload, { maxResults = 5 } = {}) {
  const limit = Math.max(1, Math.min(Number(maxResults) || 5, 10));
  let raw = payload;

  // JSON encoded inside a text item was already parsed by extractPayload; a
  // plain string here is either Markdown links or unusable prose.
  if (typeof raw === 'string') {
    const results = parseMarkdownLinks(raw, limit);
    if (results.length === 0) {
      throw new SearchError('The search provider returned text without any recognizable results.', {
        code: 'MCP_BAD_RESPONSE',
      });
    }
    return {
      results,
      answer_box: null,
      people_also_ask: [],
      related_searches: [],
      format: 'markdown',
    };
  }
  if (!raw || typeof raw !== 'object') {
    throw new SearchError('The search provider returned an empty or invalid response.', {
      code: 'MCP_BAD_RESPONSE',
    });
  }
  if (raw.error && !raw.results) {
    throw new SearchError(`The search provider returned an error: ${clean(raw.error, 300)}`, {
      code: 'MCP_PROVIDER_ERROR',
    });
  }

  const lists = candidateLists(raw);
  const seen = new Set();
  const results = [];
  for (const list of lists) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rawUrl = item.url || item.link || item.href;
      const identity = canonicalUrl(rawUrl);
      if (!identity || seen.has(identity)) continue;
      const title = clean(item.title || item.name || item.heading, MAX_TITLE);
      if (!title) continue;
      const snippet = snippetOf(item);
      const date = clean(item.date || item.publishedDate || item.published_date || item.metadata?.publishedDate, 40);
      seen.add(identity);
      results.push({
        rank: results.length + 1,
        title,
        // Keep the provider's URL (only normalized by the URL parser); the
        // canonical form is used for dedupe, not for rewriting the source.
        url: sourceUrl(rawUrl, identity),
        snippet: snippet || null,
        ...(date ? { date } : {}),
      });
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  if (results.length === 0 && lists.length === 0 && !Array.isArray(raw)) {
    // A structured response with no list at all is a schema mismatch, not a
    // valid "no results" answer. Let the manager fall back to the next provider.
    const keys = Object.keys(raw).slice(0, 8).join(', ');
    throw new SearchError(`The search provider response has an unknown shape (keys: ${keys || 'none'}).`, {
      code: 'MCP_BAD_RESPONSE',
    });
  }

  return {
    results,
    answer_box: normalizeAnswerBox(raw),
    people_also_ask: normalizePeopleAlsoAsk(raw),
    related_searches: normalizeRelated(raw),
    format: 'json',
  };
}

function normalizeAnswerBox(payload) {
  const box = payload.answer_box || payload.answerBox;
  if (!box || typeof box !== 'object') return null;
  const text = clean(box.answer || box.text || box.snippet || box.description, MAX_SNIPPET);
  if (!text) return null;
  return {
    ...(box.title ? { title: clean(box.title, MAX_TITLE) } : {}),
    text,
    ...(canonicalUrl(box.url || box.link) ? { url: canonicalUrl(box.url || box.link) } : {}),
  };
}

function normalizePeopleAlsoAsk(payload) {
  const list = payload.people_also_ask || payload.peopleAlsoAsk || payload.related_questions;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      question: clean(item?.question || item?.title, MAX_TITLE),
      snippet: clean(item?.snippet || item?.answer || item?.description, MAX_SNIPPET) || null,
    }))
    .filter((item) => item.question)
    .slice(0, 4);
}

function normalizeRelated(payload) {
  const list = payload.related_searches || payload.relatedSearches;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => clean(typeof item === 'string' ? item : item?.query, 160))
    .filter(Boolean)
    .slice(0, 5);
}

/** Parse `[title](url)` lines from text-only MCP servers. */
function parseMarkdownLinks(text, limit) {
  const results = [];
  const seen = new Set();
  const pattern = /\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g;
  let match;
  while ((match = pattern.exec(text)) && results.length < limit) {
    const identity = canonicalUrl(match[2]);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    const after = text.slice(pattern.lastIndex).split('\n')[0].replace(/^[\s:–—-]+/, '');
    results.push({
      rank: results.length + 1,
      title: clean(match[1], MAX_TITLE),
      url: sourceUrl(match[2], identity),
      snippet: after ? clean(after, MAX_SNIPPET) : null,
    });
  }
  return results;
}

/** Keep the provider's URL but reject anything the URL parser cannot read. */
function sourceUrl(value, fallback) {
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

/**
 * Normalize an extraction result to `{title, text, url}`.
 * Missing text is a valid empty extraction, not an error.
 */
export function normalizeExtractPayload(payload, { url = null } = {}) {
  const empty = { title: '', text: '', url };
  if (typeof payload === 'string') {
    return { ...empty, text: cleanText(payload) };
  }
  if (!payload || typeof payload !== 'object') return empty;
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const first = Array.isArray(data.results) ? data.results[0] : null;
  const text =
    firstString(
      data.markdown,
      data.content,
      data.text,
      data.rawContent,
      data.raw_content,
      payload.markdown,
      payload.text,
      first?.raw_content,
      first?.rawContent,
      first?.content,
      first?.text,
    ) || '';
  const title = clean(data.title || data.metadata?.title || first?.title || payload.title, 300);
  const finalUrl = canonicalUrl(data.url || data.metadata?.sourceURL || first?.url || url) || url;
  return { title, text: cleanText(text), url: finalUrl };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function cleanText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, MAX_TEXT);
}

export const NORMALIZE_LIMITS = { MAX_TITLE, MAX_SNIPPET, MAX_URL, MAX_TEXT };
