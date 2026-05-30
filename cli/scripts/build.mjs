#!/usr/bin/env node
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outfile = path.join(root, "bin", "lynn.mjs");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const inkDevtoolsStub = path.join(root, "scripts", "ink-devtools-stub.mjs");

fs.mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __lynnCreateRequire } from 'node:module';\nconst require = __lynnCreateRequire(import.meta.url);" },
  define: {
    __LYNN_CLI_NAME__: JSON.stringify(packageJson.name || "@lynn/cli"),
    __LYNN_CLI_VERSION__: JSON.stringify(packageJson.version || "0.0.0-dev"),
    "process.env.DEV": JSON.stringify("false"),
  },
  external: [],
  plugins: [
    {
      name: "lynn-ink-devtools-stub",
      setup(build) {
        build.onResolve({ filter: /^\.\/devtools\.js$/ }, (args) => {
          if (args.importer.includes(`${path.sep}ink${path.sep}build${path.sep}reconciler.js`)) {
            return { path: inkDevtoolsStub };
          }
          return null;
        });
      },
    },
  ],
});

fs.chmodSync(outfile, 0o755);
console.log(`[lynn-cli] built ${path.relative(root, outfile)}`);
