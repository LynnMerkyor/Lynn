import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { call } = await import(pathToFileURL(process.argv[2]).href);
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (_url, options) => {
  requests.push(JSON.parse(options.body));
  return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
try {
  for (const type of ['image_url', 'input_image']) {
    for (const historyLength of [0, 8]) {
      const image = { type, image_url: { url: 'data:image/png;base64,cHJvYmU=' } };
      const messages = [
        { role: 'user', content: [image] },
        ...Array.from({ length: historyLength }, () => ({ role: 'assistant', content: 'history' })),
        { role: 'user', content: 'Describe the provided image' },
      ];
      const provider = { id: 'native-vision-probe', model: 'native-vision-probe', endpoint: 'https://unused.invalid/v1', apiKey: 'test-only', capability: { vision: true, tools: false } };
      for await (const chunk of call({ provider, messages })) void chunk;
      assert.equal(requests.at(-1).model, provider.model);
      assert.deepEqual(requests.at(-1).messages[0].content[0], image);
    }
  }
  const textOnly = { id: 'text-probe', model: 'text-probe', endpoint: 'https://unused.invalid/v1', apiKey: 'test-only', capability: { vision: false, tools: false } };
  for await (const chunk of call({ provider: textOnly, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,cHJvYmU=' } }] }] })) void chunk;
  assert.deepEqual(requests.at(-1).messages[0].content[0], { type: 'text', text: '[earlier image omitted]' });
  console.log('PASS native vision retains recent and older image_url/input_image payloads; text-only filtering retained; zero external requests');
} finally {
  globalThis.fetch = originalFetch;
}
