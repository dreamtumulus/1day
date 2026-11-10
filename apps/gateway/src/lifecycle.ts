/** Abortable waits shared by account selection, refresh, and cloud polling. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * One periodic lease / budget renewal (review 2026-11-09 G). `renew` returns false — or throws an error `isLoss`
 * recognises — when the lease is really gone: `onLost` runs at once. Any other throw is a failed database call
 * (SQLITE_BUSY, I/O): it is retried, `tries` in all with a doubling backoff, and only then is the request given up.
 */
export function renewWithRetry(
  renew: () => boolean | void,
  onLost: (err: unknown) => void,
  opts: { tries: number; backoffMs: number; label: string; isLoss?: (err: unknown) => boolean; stopped?: () => boolean },
  attempt = 1,
): void {
  if (opts.stopped?.()) return;
  try {
    if (renew() === false) onLost(new Error(`${opts.label} lease lost`));
  } catch (err) {
    if (opts.isLoss?.(err) || attempt >= opts.tries) {
      console.error(`[lease] ${opts.label} renewal ${opts.isLoss?.(err) ? "found the lease gone" : `failed ${attempt} times`}; aborting its request`, err);
      onLost(err);
      return;
    }
    console.warn(`[lease] ${opts.label} renewal failed (try ${attempt}/${opts.tries}), retrying: ${(err as Error)?.message ?? err}`);
    setTimeout(() => renewWithRetry(renew, onLost, opts, attempt + 1), opts.backoffMs * 2 ** (attempt - 1)).unref();
  }
}

/** A producer waits for its consumer instead of accumulating an unbounded SSE queue. */
export class StreamDemand {
  private wake?: () => void;
  private cancelled = false;
  pull(): void { this.wake?.(); this.wake = undefined; }
  cancel(): void { this.cancelled = true; this.pull(); }
  async write(controller: ReadableStreamDefaultController<Uint8Array>, value: Uint8Array): Promise<void> {
    if (!value.length) return;
    if (value.length > 8_388_608) throw new Error("produced event exceeds 8 MiB");
    while (!this.cancelled && controller.desiredSize !== null && controller.desiredSize <= 0) await new Promise<void>(r => { this.wake = r; });
    if (this.cancelled || controller.desiredSize === null) throw new DOMException("Response cancelled", "AbortError");
    controller.enqueue(value);
  }
  close(controller: ReadableStreamDefaultController<Uint8Array>): void { if (!this.cancelled) { this.cancelled = true; controller.close(); } }
}

export async function responseBytes(res: Response, maxBytes: number, signal?: AbortSignal, truncate = false): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > maxBytes) {
        await reader.cancel().catch(() => {});
        if (!truncate) throw new Error(`upstream response exceeds ${maxBytes} bytes`);
        chunks.push(value.subarray(0, maxBytes - size)); size = maxBytes; break;
      }
      chunks.push(value); size += value.length;
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
}
