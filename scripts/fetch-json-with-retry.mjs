const DEFAULT_RETRYABLE_STATUS = (status) => status === 429 || status >= 500;

function retryAfterDelay(response, fallbackMs) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : fallbackMs;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Fetch JSON with a bounded timeout and retries for transient failures only. */
export async function fetchJsonWithRetry(url, {
  attempts = 3,
  timeoutMs = 15_000,
  retryDelaysMs = [250, 750],
  headers = {},
  fetchImpl = fetch,
  waitImpl = wait,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let retryDelay = retryDelaysMs[attempt] ?? retryDelaysMs.at(-1) ?? 750;
    try {
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`${url} returned HTTP ${response.status}`);
        error.status = response.status;
        if (!DEFAULT_RETRYABLE_STATUS(response.status)) throw error;
        retryDelay = retryAfterDelay(response, retryDelay);
        lastError = error;
      } else {
        return await response.json();
      }
    } catch (error) {
      const timedOut = controller.signal.aborted;
      lastError = timedOut
        ? new Error(`${url} timed out after ${timeoutMs}ms`)
        : error;
      const status = Number(error?.status);
      if (Number.isFinite(status) && !DEFAULT_RETRYABLE_STATUS(status)) throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < attempts - 1) await waitImpl(retryDelay);
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`${url} failed after ${attempts} attempts: ${detail}`);
}
