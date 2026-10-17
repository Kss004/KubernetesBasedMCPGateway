// Same-origin JSON API with the session cookie. The JSON content type on every
// request is also the CSRF defence the gateway checks on session mutations.
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// Run an async action and report failures in the shared status line.
export const guard = (setStatus, fn) => async (...args) => {
  try {
    setStatus('');
    await fn(...args);
  } catch (e) {
    setStatus(e.message || String(e));
  }
};
