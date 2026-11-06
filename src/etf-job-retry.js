const RETRY_DELAY_MS = 10000;
const MAX_ATTEMPTS = 3;
const RUN_BUDGET_MS = 270000;
const MIN_ATTEMPT_BUDGET_MS = 30000;

export async function runEtfJobWithRetry(task, {
  now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onRetry = () => {}
} = {}) {
  const deadline = now() + RUN_BUDGET_MS;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (deadline - now() < MIN_ATTEMPT_BUDGET_MS) break;
    try {
      return await task({ attempt, deadline });
    } catch (error) {
      lastError = error;
      error.retryAttempts = attempt;
      if (!isRetryableEtfError(error) || attempt === MAX_ATTEMPTS) throw error;
      if (deadline - now() < RETRY_DELAY_MS + MIN_ATTEMPT_BUDGET_MS) break;
      onRetry({ attempt, error });
      await wait(RETRY_DELAY_MS);
    }
  }
  if (!lastError) lastError = new Error("ETF job execution budget exhausted");
  throw lastError;
}

export function isRetryableEtfError(error) {
  if (["REPORT_STORAGE_CONFLICT", "REPORT_STATE_CONFLICT", "REPORT_STEP_TIMEOUT"].includes(error?.code)) return true;
  const status = Number(error?.status);
  if (status === 408 || status === 429 || status >= 500 && status < 600) return true;
  if (status >= 400 && status < 500) return false;
  if (["TimeoutError", "AbortError"].includes(error?.name)) return true;
  const code = String(error?.cause?.code || error?.code || "");
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/.test(code)) return true;
  return /fetch failed|request failed (408|429|5\d\d)|HTTP\s*(408|429|5\d\d)|quote response incomplete|缺少.*14:50.*分钟/i.test(String(error?.message || ""));
}
