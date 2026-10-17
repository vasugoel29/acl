// Enterprise BFF Authentication & API Client for NSUT Identity & ACL Admin Console
export const API = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? window.location.origin : 'http://localhost:4000');
const CLIENT_ID = 'ACL';
const REDIRECT = `${location.origin}/callback`;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function startLogin() {
  const verifier = rand(48);
  const state = rand(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('pkce', JSON.stringify({ verifier, state }));
  location.href = `${API}/authorize?` + new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
}

/** Handles OIDC redirect callback and establishes httpOnly BFF session cookies */
export async function handleCallback() {
  if (location.pathname !== '/callback') return false;
  const q = new URLSearchParams(location.search);
  const saved = JSON.parse(sessionStorage.getItem('pkce') ?? 'null');
  history.replaceState({}, '', '/');
  sessionStorage.removeItem('pkce');

  if (q.get('error')) {
    throw new Error(q.get('error') === 'access_denied' ? 'Access denied. Please authenticate with an @nsut.ac.in or @nsit.ac.in account.' : q.get('error'));
  }
  if (!saved || saved.state !== q.get('state')) {
    throw new Error('Authentication state validation failed. Please try again.');
  }

  // Token exchange: sets httpOnly SameSite session cookies in the browser
  const r = await fetch(`${API}/token`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code: q.get('code'),
      code_verifier: saved.verifier,
      redirect_uri: REDIRECT,
    }),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error_description || err.error || 'Token exchange failed');
  }

  return true;
}

let refreshPromise = null;

async function tryRefreshSession() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetch(`${API}/api/admin/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

export async function fetchCurrentSession() {
  try {
    let r = await fetch(`${API}/api/admin/auth/me`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    if (r.status === 401 && (await tryRefreshSession())) {
      r = await fetch(`${API}/api/admin/auth/me`, {
        method: 'GET',
        credentials: 'include',
        headers: { 'x-requested-with': 'XMLHttpRequest' },
      });
    }
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function logout() {
  const doReq = () =>
    fetch(`${API}/api/admin/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
  let r = await doReq().catch(() => null);
  if (r && r.status === 401 && (await tryRefreshSession())) {
    r = await doReq().catch(() => null);
  }
  if (!r || !r.ok) {
    let msg = r ? `HTTP ${r.status}` : 'Network error';
    try {
      const err = await r?.json();
      msg = err?.error || msg;
    } catch {}
    throw new Error(`Logout failed: ${msg}`);
  }
  location.reload();
}

export function downloadErrorReport(jobId) {
  window.open(`${API}/v1/jobs/${jobId}/errors.csv`, '_blank');
}

export function downloadExportFile(jobId) {
  window.open(`${API}/v1/jobs/${jobId}/download.csv`, '_blank');
}

export async function api(path, { method = 'GET', body, raw } = {}) {
  const doReq = () =>
    fetch(`${API}${path}`, {
      method,
      credentials: 'include',
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        ...(body !== undefined ? { 'content-type': raw ? 'text/csv' : 'application/json' } : {}),
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });

  let r = await doReq();
  if (r.status === 401 && (await tryRefreshSession())) {
    r = await doReq();
  }

  if (r.status === 204) return null;

  if (!r.ok) {
    let data;
    try {
      data = await r.json();
    } catch {
      const text = await r.text().catch(() => '');
      throw new Error(text || `HTTP ${r.status}`);
    }
    throw new Error(
      data.error
        ? `${data.error}${data.detail ? `: ${data.detail}` : ''}${data.issues ? ': ' + data.issues.map((i) => i.message).join(', ') : ''}`
        : `HTTP ${r.status}`,
    );
  }

  return await r.json();
}
