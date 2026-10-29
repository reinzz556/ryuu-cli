import { BUILTIN_PROVIDERS } from '../providers/catalog.js';
import { AGENT_SETTING_KEYS, WEB_SETTING_KEYS } from './load.js';
import { SETTINGS_VERSION, readSettings, settingsFile, writeSettings } from './settings.js';

/**
 * First-run configuration scaffolding.
 *
 * `config.json` is the only configuration source, so a missing file used to
 * leave a new install with nothing to look at. `buildSettingsSkeleton` returns
 * the documented shape with every editable key present and empty: an empty
 * value means "use the built-in default" during validation, which lets the file
 * double as a checklist without changing behaviour.
 */
export function buildSettingsSkeleton({ providerIds = BUILTIN_PROVIDERS.map((provider) => provider.id) } = {}) {
  const providers = {};
  const providerModel = {};
  for (const id of providerIds) {
    providers[id] = { apiKey: '', baseURL: '' };
    providerModel[id] = '';
  }
  const skeleton = {
    version: SETTINGS_VERSION,
    provider: '',
    providers,
    providerModel,
    extraProviders: [],
    agent: {},
    webSearch: {},
  };
  for (const key of AGENT_SETTING_KEYS) skeleton.agent[key] = '';
  for (const key of Object.keys(WEB_SETTING_KEYS)) skeleton.webSearch[key] = '';
  return skeleton;
}

/**
 * Create the settings file when it is missing. Existing files are returned
 * untouched (including a malformed one, which readSettings reports), so a
 * startup never overwrites something the user wrote.
 *
 * Returns the readSettings result plus `created`; the file is written with the
 * same atomic, owner-only path as every other settings save.
 */
export async function ensureSettingsFile({ file = null, ...options } = {}) {
  const target = file || settingsFile(options);
  const current = await readSettings({ file: target });
  if (current.exists) return { ...current, created: false };
  const data = buildSettingsSkeleton();
  await writeSettings(data, { file: target });
  return { file: target, exists: true, created: true, data };
}
