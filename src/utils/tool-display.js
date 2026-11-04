/**
 * Nama tool untuk manusia.
 *
 * Plugin mendaftarkan tool sebagai `app_tool` karena nama fungsi provider
 * (OpenAI/Anthropic) hanya menerima huruf, angka, `_` dan `-`. Di layar, tool
 * plugin dibaca `app:tool` (mis. `vercel:get_project`) agar asal integrasinya
 * langsung terlihat. Tool bawaan tidak diubah.
 */
export function toolDisplayName(name, plugin = null) {
  const text = String(name ?? '');
  if (!plugin) return text;
  const separator = text.indexOf('_');
  if (separator <= 0) return text;
  return `${text.slice(0, separator)}:${text.slice(separator + 1)}`;
}
