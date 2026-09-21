let token = "";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown,
  ) {
    super(message);
  }
}
export async function bootstrap() {
  const response = await fetch("/api/bootstrap");
  if (!response.ok) throw new Error("The local server could not be reached.");
  token = (await response.json()).token;
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-FlowDesk-Token": token,
      ...options.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    let data: unknown;
    try {
      const body = await response.json();
      data = body;
      message = body.error?.message ?? body.error ?? body.message ?? message;
    } catch {
      /* Preserve HTTP error. */
    }
    throw new ApiError(String(message), response.status, data);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function download(path: string, name: string) {
  const response = await fetch(`/api${path}`, {
    headers: { "X-FlowDesk-Token": token },
  });
  if (!response.ok) {
    let message = `Export failed (${response.status}). Save and try again.`;
    try {
      const body = await response.json();
      message = body.error?.message ?? body.error ?? body.message ?? message;
    } catch {
      // Preserve a useful fallback when a proxy or server returns non-JSON text.
    }
    throw new ApiError(String(message), response.status);
  }
  downloadBlob(await response.blob(), name);
}
