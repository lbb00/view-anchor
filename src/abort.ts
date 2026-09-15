const NOOP = (): void => {}

/** Attach a one-shot abort listener and return a function that detaches it. */
export function watchAbort(signal: AbortSignal | undefined, dispose: () => void): () => void {
  if (!signal) return NOOP
  const onAbort = (): void => dispose()
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}
