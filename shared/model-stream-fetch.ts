import { getGlobalDispatcher, type Dispatcher } from "undici";

export function modelStreamFetch(input: string | URL | Request, init: RequestInit): Promise<Response> {
  const parent = getGlobalDispatcher();
  const dispatcher = {
    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
      return parent.dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler);
    },
  };
  return globalThis.fetch(input, { ...init, dispatcher } as RequestInit);
}
