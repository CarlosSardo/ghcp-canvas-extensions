export async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started <= timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out after ${timeout}ms waiting for condition`);
}
