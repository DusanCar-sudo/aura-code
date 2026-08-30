/**
 * Authentication helper for Aura Code.
 * Securely resolves the session token across Web and Tauri desktop environments.
 */

let inMemoryToken: string | null = null;

export function isTauri(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
}

export function setCachedToken(token: string): void {
  if (!token) return;
  inMemoryToken = token;
  try {
    sessionStorage.setItem('aura_token', token);
    localStorage.setItem('aura_token', token);
  } catch {}
}

/**
 * Forget the current token everywhere.
 *
 * Called when the server rejects it. Without this a stale token in
 * localStorage outlives the run it belonged to and every later request fails
 * with the same 401 until the user clears site data by hand.
 */
export function clearCachedToken(): void {
  inMemoryToken = null;
  try {
    sessionStorage.removeItem('aura_token');
    localStorage.removeItem('aura_token');
  } catch {}
}

/** Ask the Rust side. Empty string if unavailable, never throws. */
async function tokenFromTauri(): Promise<string> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke<string>('get_auth_token'))?.trim() ?? '';
  } catch (err) {
    console.warn('Could not retrieve token via Tauri IPC:', err);
    return '';
  }
}

export async function getAuthToken(): Promise<string> {
  if (inMemoryToken) return inMemoryToken;
  if (typeof window === 'undefined') return '';

  // In Tauri the IPC answer is authoritative and is checked FIRST.
  //
  // The server mints a fresh random token on every run and writes it to
  // ~/.aura/active_token, which is what `get_auth_token` reads. Web storage,
  // by contrast, survives across runs — so consulting it first hands back the
  // *previous* run's token and every request 401s for as long as the app is
  // installed. Storage is a browser fallback, not a source of truth.
  if (isTauri()) {
    const tauriToken = await tokenFromTauri();
    if (tauriToken) {
      setCachedToken(tauriToken);
      return tauriToken;
    }
  }

  // 1. URL search params (e.g. ?token=...) — how the browser UI is opened.
  try {
    const urlToken = new URLSearchParams(window.location.search).get('token');
    if (urlToken) {
      setCachedToken(urlToken);
      return urlToken;
    }
  } catch {}

  // 2. Storage, so a reload inside the browser keeps working.
  try {
    const stored = sessionStorage.getItem('aura_token') || localStorage.getItem('aura_token');
    if (stored) {
      inMemoryToken = stored;
      return stored;
    }
  } catch {}

  return '';
}

/**
 * Drop the cached token and resolve it again from source.
 *
 * The recovery path after a 401: the token we hold is known bad, so anything
 * derived from it — including storage — has to be discarded before asking.
 */
export async function refreshAuthToken(): Promise<string> {
  clearCachedToken();
  return getAuthToken();
}

export function getAuthTokenSync(): string {
  if (inMemoryToken) return inMemoryToken;
  if (typeof window !== 'undefined') {
    try {
      const urlToken = new URLSearchParams(window.location.search).get('token');
      if (urlToken) {
        setCachedToken(urlToken);
        return urlToken;
      }
    } catch {}
    try {
      const stored = sessionStorage.getItem('aura_token') || localStorage.getItem('aura_token');
      if (stored) {
        inMemoryToken = stored;
        return stored;
      }
    } catch {}
  }
  return '';
}

/**
 * Perform an authenticated HTTP fetch request with token appended to URL and headers.
 */
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const send = (token: string) => {
    const sep = url.includes('?') ? '&' : '?';
    const targetUrl = token && !url.includes('token=')
      ? `${url}${sep}token=${encodeURIComponent(token)}`
      : url;

    const headers = new Headers(init?.headers || {});
    if (token) {
      if (!headers.has('x-aura-token')) headers.set('x-aura-token', token);
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(targetUrl, { ...init, headers });
  };

  const res = await send(await getAuthToken());

  // One retry on rejection, with the token re-resolved from source. A token
  // left over from an earlier run is the common case in the desktop app, and
  // it is fixable without the user knowing a token exists at all. Only retry
  // when the second token actually differs, so a genuinely unauthorized
  // request fails once rather than twice.
  if (res.status === 401 || res.status === 403) {
    const stale = inMemoryToken;
    const fresh = await refreshAuthToken();
    if (fresh && fresh !== stale) return send(fresh);
  }

  return res;
}
