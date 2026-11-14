/**
 * Nama tool untuk manusia.
 *
 * Plugin mendaftarkan tool sebagai `app_tool` karena nama fungsi provider
 * (OpenAI/Anthropic) hanya menerima huruf, angka, `_` dan `-`. Di layar, tool
 * plugin dibaca `app:tool` (mis. `vercel:get_project`) agar asal integrasinya
 * langsung terlihat. Tool bawaan tidak diubah.
 *
 * MCP punya identitas sendiri: `mcp:<server>:<tool>` (mis.
 * `mcp:google-drive:search_files`). Bagian `mcp` diberi warna kuning oleh
 * renderer, sisanya biru langit.
 */
export function toolDisplayName(name, plugin = null) {
  const text = String(name ?? '');
  if (!plugin) return text;
  // The registry stores MCP servers as plugins with display metadata, so
  // `/tools` and any direct caller get the MCP form without extra plumbing.
  if (plugin.mcp) {
    const original = plugin.displayNames?.[text] || text;
    return mcpDisplayName(plugin.server || 'server', original);
  }
  const separator = text.indexOf('_');
  if (separator <= 0) return text;
  return `${text.slice(0, separator)}:${text.slice(separator + 1)}`;
}

/** `mcp:<server>:<tool>` from the event metadata (agent → renderer path). */
export function mcpDisplayName(server, tool) {
  return `mcp:${server || 'server'}:${tool ?? ''}`;
}

/** True when a tool display name belongs to an MCP server. */
export function isMcpToolName(name, plugin = null) {
  return Boolean(plugin?.mcp) || /^mcp:/.test(String(name ?? ''));
}
