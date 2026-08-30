import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/theme.css';
import './styles/app.css';
import { getAuthToken } from './lib/auth';

// ── Secure Global Fetch Interceptor for Tauri & Web ──
const originalFetch = window.fetch;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let url = '';
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else if (input && typeof input === 'object' && 'url' in input) {
    url = (input as Request).url;
  }

  // Intercept relative paths or local API endpoints
  if (
    url.startsWith('/') ||
    url.startsWith('./') ||
    url.startsWith('http://localhost:7337') ||
    url.startsWith('http://127.0.0.1:7337') ||
    url.startsWith('http://localhost:5173') ||
    url.startsWith('http://127.0.0.1:5173')
  ) {
    const isTauri = Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
    // Map relative paths to the backend server if running inside Tauri
    if (isTauri && (url.startsWith('/') || url.startsWith('./'))) {
      const cleanPath = url.startsWith('./') ? url.slice(2) : url.startsWith('/') ? url.slice(1) : url;
      url = `http://127.0.0.1:7337/${cleanPath}`;
    }

    const token = await getAuthToken();
    if (token) {
      if (!url.includes('token=')) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}token=${encodeURIComponent(token)}`;
      }

      const headers = new Headers(init?.headers || {});
      if (!headers.has('x-aura-token')) {
        headers.set('x-aura-token', token);
      }
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }

      if (input instanceof Request) {
        const req = new Request(url, {
          method: input.method,
          headers,
          body: input.body,
          mode: input.mode,
          credentials: input.credentials,
          cache: input.cache,
          redirect: input.redirect,
          referrer: input.referrer,
          integrity: input.integrity,
          keepalive: input.keepalive,
          signal: input.signal,
        });
        return originalFetch(req);
      } else {
        return originalFetch(url, { ...init, headers });
      }
    }
  }

  return originalFetch(input, init);
};

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
