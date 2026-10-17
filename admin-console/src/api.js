// Enterprise BFF Authentication & API Client for NSUT Identity & ACL Admin Console
export const API = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? window.location.origin : 'http://localhost:4000');
const CLIENT_ID = 'ACL';
const REDIRECT = `${location.origin}/callback`;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

const PKCE_TTL_MS = 10 * 60 * 1000;

function savePkce(state, verifier) {
  const payload = JSON.stringify({ verifier, state, createdAt: Date.now() });
  try {
    sessionStorage.setItem('pkce', payload);
    sessionStorage.setItem(`pkce:${state}`, payload);
  } catch {
    /* ignore storage quota/privacy errors */
  }
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('pkce:')) {
        try {
          const item = JSON.parse(localStorage.getItem(k) || 'null');
          if (!item?.createdAt || now - item.createdAt > PKCE_TTL_MS) {
            localStorage.removeItem(k);
          }
        } catch {
          localStorage.removeItem(k);
        }
      }
    }
    localStorage.setItem(`pkce:${state}`, payload);
    localStorage.setItem('pkce_latest', payload);
  } catch {
    /* ignore storage quota/privacy errors */
  }
  try {
    const secureFlag = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `acl_pkce=${encodeURIComponent(payload)}; path=/; max-age=600; SameSite=Lax${secureFlag}`;
  } catch {
    /* ignore cookie errors */
  }
}

function clearPkce(state) {
  try {
    sessionStorage.removeItem('pkce');
    if (state) sessionStorage.removeItem(`pkce:${state}`);
  } catch {}
  try {
    if (state) localStorage.removeItem(`pkce:${state}`);
    localStorage.removeItem('pkce_latest');
  } catch {}
  try {
    document.cookie = 'acl_pkce=; path=/; max-age=0; SameSite=Lax';
  } catch {}
}

function loadAndClearPkce(expectedState) {
  const candidates = [];
  const tryParse = (raw) => {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  try {
    if (expectedState) candidates.push(tryParse(sessionStorage.getItem(`pkce:${expectedState}`)));
    candidates.push(tryParse(sessionStorage.getItem('pkce')));
  } catch {}

  try {
    if (expectedState) candidates.push(tryParse(localStorage.getItem(`pkce:${expectedState}`)));
    candidates.push(tryParse(localStorage.getItem('pkce_latest')));
  } catch {}

  try {
    const match = document.cookie
      .split('; ')
      .find((row) => row.startsWith('acl_pkce='));
    if (match) {
      candidates.push(tryParse(decodeURIComponent(match.slice('acl_pkce='.length))));
    }
  } catch {}

  clearPkce(expectedState);

  if (expectedState) {
    const exact = candidates.find((c) => c && c.state === expectedState && c.verifier);
    if (exact) return exact;
  }
  return candidates.find((c) => c && c.verifier && c.state) || null;
}

export async function startLogin() {
  const verifier = rand(48);
  const state = rand(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  savePkce(state, verifier);
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
  const returnedState = q.get('state');
  const saved = loadAndClearPkce(returnedState);
  history.replaceState({}, '', '/');

  if (q.get('error')) {
    const errCode = q.get('error');
    const errDesc = q.get('error_description');
    if (errDesc) throw new Error(errDesc);
    if (errCode === 'access_denied') {
      throw new Error('Access denied. Please sign in with an authorized @nsut.ac.in or @nsit.ac.in Google Workspace account.');
    }
    if (errCode === 'session_expired') {
      throw new Error('Your sign-in session expired. Please try signing in again.');
    }
    throw new Error(errCode);
  }

  if (!q.get('code')) {
    return false;
  }

  if (!saved || saved.state !== returnedState) {
    const existing = await fetchCurrentSession().catch(() => null);
    if (existing) return true;
    throw new Error('Your sign-in session expired or was opened in a different browser window. Please tap "Sign In with Google Workspace" to continue.');
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
  let r;
  try {
    r = await fetch(`${API}/api/admin/auth/me`, {
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
  } catch {
    return null;
  }
  if (r.status === 403) {
    const errData = await r.json().catch(() => ({}));
    throw new Error(
      errData.error ||
        'Access denied. Your account does not have administrative permissions to access the NSUT Identity Console.',
    );
  }
  if (!r.ok) return null;
  return await r.json().catch(() => null);
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
