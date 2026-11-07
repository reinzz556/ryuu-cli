import { ValidationError, RyuuError } from '../../../../src/utils/errors.js';
import { GitHubPluginError, GITHUB_CODES } from './errors.js';

/**
 * Pembantu bersama untuk definisi tool GitHub.
 *
 * Tujuannya bukan hanya validasi, tetapi juga membatasi data yang dikirim ke
 * model: setiap list dipotong dan setiap body panjang diringkas.
 */

export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Validasi owner/repo dari argumen tool dan kembalikan prefix path API. */
export function repoBase(args = {}) {
  const owner = String(args.owner ?? '').trim();
  const repo = String(args.repo ?? '').trim();
  if (!OWNER_RE.test(owner)) {
    throw new ValidationError('owner tidak valid: gunakan nama pengguna/organisasi GitHub (huruf, angka, tanda hubung).');
  }
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..') {
    throw new ValidationError('repo tidak valid: gunakan nama repository tanpa spasi atau garis miring.');
  }
  return `/repos/${owner}/${repo}`;
}

/** Nama branch/tag; menolak path traversal. */
export function refSegment(value, field = 'ref') {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200 || text.includes('..') || text.includes('\\')) {
    throw new ValidationError(`${field} tidak valid.`);
  }
  return text.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/** Path file relatif di dalam repository. */
export function contentPath(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 400 || text.startsWith('/') || text.includes('\\') || text.includes('\0')) {
    throw new ValidationError('path file tidak valid.');
  }
  if (text.split('/').some((part) => part === '..' || part === '.' || part.length === 0)) {
    throw new ValidationError('path file tidak boleh memuat segmen "." atau "..".');
  }
  return text.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/** Argumen pagination yang aman. */
export function pageQuery(args = {}, { perPage = 30, max = 100 } = {}) {
  const requested = Number(args.per_page);
  const per_page = Number.isInteger(requested) ? Math.min(max, Math.max(1, requested)) : perPage;
  const page = Number.isInteger(Number(args.page)) && Number(args.page) > 0 ? Number(args.page) : 1;
  return { per_page, page };
}

/** Batasi jumlah item yang dikirim ke model. */
export function limitItems(items, max = 50) {
  const list = Array.isArray(items) ? items : [];
  return list.slice(0, max);
}

/** Ringkas teks panjang (body issue/PR/commit). */
export function text(value, max = 2000) {
  const raw = value === null || value === undefined ? '' : String(value);
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

function loginOf(value) {
  return value && typeof value === 'object' ? value.login || null : value || null;
}

export function pickUser(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.id,
    login: user.login,
    name: user.name || null,
    type: user.type || null,
    company: user.company || null,
    blog: user.blog || null,
    location: user.location || null,
    bio: text(user.bio, 500),
    public_repos: user.public_repos ?? null,
    followers: user.followers ?? null,
    following: user.following ?? null,
    avatar_url: user.avatar_url || null,
    html_url: user.html_url || null,
    created_at: user.created_at || null,
    updated_at: user.updated_at || null,
  };
}

export function pickRepo(repo) {
  if (!repo || typeof repo !== 'object') return null;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: loginOf(repo.owner),
    private: Boolean(repo.private),
    fork: Boolean(repo.fork),
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
    description: text(repo.description, 500),
    default_branch: repo.default_branch || null,
    language: repo.language || null,
    visibility: repo.visibility || null,
    html_url: repo.html_url || null,
    clone_url: repo.clone_url || null,
    stargazers_count: repo.stargazers_count ?? null,
    forks_count: repo.forks_count ?? null,
    open_issues_count: repo.open_issues_count ?? null,
    permissions: repo.permissions || null,
    created_at: repo.created_at || null,
    updated_at: repo.updated_at || null,
    pushed_at: repo.pushed_at || null,
  };
}

export function pickBranch(branch) {
  if (!branch || typeof branch !== 'object') return null;
  return {
    name: branch.name,
    protected: Boolean(branch.protected),
    sha: branch.commit?.sha || null,
    commit_url: branch.commit?.url || null,
  };
}

export function pickCommit(commit) {
  if (!commit || typeof commit !== 'object') return null;
  return {
    sha: commit.sha,
    message: text(commit.commit?.message, 1500),
    author: loginOf(commit.author),
    committer: loginOf(commit.committer),
    date: commit.commit?.author?.date || commit.commit?.committer?.date || null,
    html_url: commit.html_url || null,
    parents: (commit.parents || []).map((parent) => parent.sha),
    stats: commit.stats || null,
  };
}

export function pickIssue(issue) {
  if (!issue || typeof issue !== 'object') return null;
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    state_reason: issue.state_reason || null,
    user: loginOf(issue.user),
    labels: (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name)),
    assignees: (issue.assignees || []).map((assignee) => assignee.login),
    comments: issue.comments ?? null,
    body: text(issue.body, 4000),
    html_url: issue.html_url || null,
    is_pull_request: Boolean(issue.pull_request),
    created_at: issue.created_at || null,
    updated_at: issue.updated_at || null,
    closed_at: issue.closed_at || null,
  };
}

export function pickPull(pull) {
  if (!pull || typeof pull !== 'object') return null;
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: Boolean(pull.draft),
    merged: Boolean(pull.merged),
    mergeable: pull.mergeable ?? null,
    mergeable_state: pull.mergeable_state || null,
    user: loginOf(pull.user),
    head: pull.head ? { ref: pull.head.ref, sha: pull.head.sha } : null,
    base: pull.base ? { ref: pull.base.ref, sha: pull.base.sha } : null,
    body: text(pull.body, 4000),
    additions: pull.additions ?? null,
    deletions: pull.deletions ?? null,
    changed_files: pull.changed_files ?? null,
    comments: pull.comments ?? null,
    html_url: pull.html_url || null,
    created_at: pull.created_at || null,
    updated_at: pull.updated_at || null,
    merged_at: pull.merged_at || null,
  };
}

export function pickRelease(release) {
  if (!release || typeof release !== 'object') return null;
  return {
    id: release.id,
    tag_name: release.tag_name,
    target_commitish: release.target_commitish || null,
    name: release.name || null,
    draft: Boolean(release.draft),
    prerelease: Boolean(release.prerelease),
    author: loginOf(release.author),
    body: text(release.body, 4000),
    html_url: release.html_url || null,
    tarball_url: release.tarball_url || null,
    zipball_url: release.zipball_url || null,
    created_at: release.created_at || null,
    published_at: release.published_at || null,
  };
}

export function pickWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') return null;
  return {
    id: workflow.id,
    name: workflow.name,
    path: workflow.path,
    state: workflow.state,
    html_url: workflow.html_url || null,
    created_at: workflow.created_at || null,
    updated_at: workflow.updated_at || null,
  };
}

export function pickWorkflowRun(run) {
  if (!run || typeof run !== 'object') return null;
  return {
    id: run.id,
    name: run.name || null,
    display_title: text(run.display_title, 300),
    workflow_id: run.workflow_id ?? null,
    run_number: run.run_number ?? null,
    event: run.event || null,
    status: run.status || null,
    conclusion: run.conclusion || null,
    head_branch: run.head_branch || null,
    head_sha: run.head_sha || null,
    actor: loginOf(run.actor),
    html_url: run.html_url || null,
    created_at: run.created_at || null,
    updated_at: run.updated_at || null,
    run_started_at: run.run_started_at || null,
  };
}

/** Operasi destruktif bisa dimatikan lewat `/github config set confirmDestructive false`. */
export async function assertDestructiveAllowed(plugin, action) {
  const settings = await plugin.loadConfig();
  if (!settings.confirmDestructive) {
    throw new GitHubPluginError(
      `${action} diblokir karena confirmDestructive=false. Aktifkan lagi dengan /github config set confirmDestructive true.`,
      { code: GITHUB_CODES.DESTRUCTIVE },
    );
  }
}

/** Cek `ok` pada respons yang tidak melempar error. */
export function assertOk(value, message) {
  if (!value || value.ok === false) {
    throw new RyuuError(message, { code: 'GITHUB_UNEXPECTED' });
  }
  return value;
}
