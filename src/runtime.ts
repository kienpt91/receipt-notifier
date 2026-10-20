/** Aborts on SIGINT/SIGTERM, so loops can finish the current batch and exit. */
export function shutdownSignal() {
  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => controller.abort());
  return controller.signal;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
