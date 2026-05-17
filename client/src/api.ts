const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_AUTH_TOKEN = import.meta.env.VITE_API_AUTH_TOKEN;

type ApiOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
};

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

function extractMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const value = data as { error?: unknown; message?: unknown };
    if (typeof value.error === 'string') return value.error;
    if (typeof value.message === 'string') return value.message;
  }
  return fallback;
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (API_AUTH_TOKEN) {
    headers['X-API-Key'] = API_AUTH_TOKEN;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch (error) {
    throw new ApiError(
      'API nicht erreichbar. Läuft der Server und stimmt die API-URL?',
      0,
      error
    );
  }

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || 'Ungültige API-Antwort.' };
  }

  if (!response.ok) {
    throw new ApiError(extractMessage(data, `API-Fehler ${response.status}`), response.status, data);
  }

  return data as T;
}

export const apiGet = <T>(path: string) => apiRequest<T>(path);
export const apiPost = <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body });
export const getApiBaseUrl = () => API_BASE_URL;
