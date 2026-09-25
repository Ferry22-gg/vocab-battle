export interface QueryResult {
  data: unknown;
  error: unknown;
}

export interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * A minimal stand-in for a supabase-js chainable query builder, used to
 * test a DAL function's *call contract* (which columns/filters/ordering
 * it asks for, and how it shapes the result) without a real database.
 * Every method call (`.select()`, `.eq()`, `.order()`, `.limit()`,
 * `.maybeSingle()`, ...) is recorded and returns the same chain object,
 * so any sequence of chained calls is supported; awaiting the chain at
 * any point resolves to `result`, matching how a real supabase-js query
 * builder is itself a thenable resolving to `{ data, error }` regardless
 * of how many chain methods preceded the `await`.
 */
export function createQueryChainMock(result: QueryResult): {
  chain: Record<string, (...args: unknown[]) => unknown>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const chain = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          const promise = Promise.resolve(result);
          return promise.then.bind(promise);
        }
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return chain;
        };
      },
    },
  ) as Record<string, (...args: unknown[]) => unknown>;

  return { chain, calls };
}
