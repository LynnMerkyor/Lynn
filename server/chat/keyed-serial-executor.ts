export function createKeyedSerialExecutor() {
  const tails = new Map<string, Promise<void>>();

  return async function runSerial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key);
    const result = previous
      ? previous.catch(() => {}).then(task)
      : Promise.resolve(task());
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
