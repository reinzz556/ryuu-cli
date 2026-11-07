import { createAccountTools } from './tools-account.js';
import { createProjectTools } from './tools-projects.js';
import { createDeploymentTools } from './tools-deployments.js';
import { createEnvTools } from './tools-env.js';
import { createDomainTools } from './tools-domains.js';
import { createEdgeTools } from './tools-edge.js';
import { createMonitoringTools } from './tools-monitoring.js';

/**
 * Seluruh tool AI Vercel.
 *
 * Semua handler memakai `plugin.requireClient()` sehingga otomatis:
 *  - memeriksa integrasi aktif,
 *  - memastikan pengguna sudah login,
 *  - melewati backend (token Vercel tidak pernah ada di proses CLI).
 */
export function createVercelTools(plugin) {
  const tools = [
    ...createAccountTools(plugin),
    ...createProjectTools(plugin),
    ...createDeploymentTools(plugin),
    ...createEnvTools(plugin),
    ...createDomainTools(plugin),
    ...createEdgeTools(plugin),
    ...createMonitoringTools(plugin),
  ];
  const seen = new Set();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`Tool Vercel duplikat: ${tool.name}`);
    seen.add(tool.name);
    if (!tool.name.startsWith('vercel_')) throw new Error(`Nama tool harus berawalan vercel_: ${tool.name}`);
  }
  return tools;
}


