function getApiToken() {
  let token = sessionStorage.getItem('kalshibot_api_token') || '';
  if (!token) {
    token = window.prompt('Enter the Kalshibot control token') || '';
    token = token.trim();
    if (token) sessionStorage.setItem('kalshibot_api_token', token);
  }
  return token;
}

async function authenticatedFetch(url, options = {}) {
  const token = getApiToken();
  if (!token) throw new Error('Control token required');
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    sessionStorage.removeItem('kalshibot_api_token');
  }
  return response;
}


export { getApiToken, authenticatedFetch };
