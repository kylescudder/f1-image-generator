export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status}).`);
  return data as T;
}
export const post = <T>(url: string, body?: unknown) =>
  request<T>(url, { method: "POST", body: JSON.stringify(body || {}) });
export const put = <T>(url: string, body: unknown) =>
  request<T>(url, { method: "PUT", body: JSON.stringify(body) });
export const remove = <T>(url: string) => request<T>(url, { method: "DELETE" });
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
export const readDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
