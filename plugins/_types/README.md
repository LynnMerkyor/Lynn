# Lynn Plugin Types

Plugin implementations stay in JavaScript so plugin authors can work without a build step. These `.d.ts` files provide editor hints and shared contracts for tools, routes, manifests, and plugin context objects.

Example:

```js
/** @typedef {import("../_types").PluginToolContext} PluginToolContext */

/**
 * @param {{ text: string }} params
 * @param {PluginToolContext} ctx
 */
export async function execute(params, ctx) {
  ctx.log.info?.("speak", params.text);
}
```

Use these types for new first-party plugins and for documentation examples. Do not convert third-party or user-authored plugins to TypeScript just for coverage.

