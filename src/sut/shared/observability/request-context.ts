import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context propagated through async calls so outbound HTTP calls
 * (gateway -> services) and published events carry the same request ID
 * without threading it through every function signature.
 */
export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
