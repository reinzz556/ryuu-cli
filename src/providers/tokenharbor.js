import { TOKENHARBOR_BASE_URL, TOKENHARBOR_MODEL } from './catalog.js';
import { registerRequestExtras, passthroughExtras } from './vendor-extras.js';

/**
 * Token Harbor provider.
 *
 * It speaks the OpenAI Chat Completions protocol and already returns
 * `reasoning_content`, so it needs no vendor request field: the module exists
 * to own the provider's defaults and to be the place a future Token Harbor-only
 * field would go.
 *
 * A user `extraProviders` entry may still carry `extraBody`/`requestParams`; they
 * are passed through untouched, which makes an unusual gateway reachable without
 * a code change.
 */

export const TOKENHARBOR_DOCS_URL = 'https://tokenharbor.ai/';

/** Request-body extension for Token Harbor: only explicit pass-through fields. */
export function tokenHarborRequestExtras(config = {}) {
  return passthroughExtras(config);
}

/** Declared descriptor, kept next to the client like the other provider modules. */
export function tokenHarborDescriptor() {
  return {
    id: 'tokenharbor',
    name: 'Token Harbor',
    apiFormat: 'openai-chat-completions',
    baseURL: TOKENHARBOR_BASE_URL,
    defaultModel: TOKENHARBOR_MODEL,
    models: [{ id: TOKENHARBOR_MODEL, name: 'DeepSeek V4.1 Flash Free', default: true }],
    capabilities: { streaming: true, tools: true, reasoning: true, multimodal: false },
    docsUrl: TOKENHARBOR_DOCS_URL,
  };
}

registerRequestExtras('tokenharbor', tokenHarborRequestExtras);