import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "bundle/pma.js",
  minify: true,
  jsx: "automatic",
  // ink imports react-devtools-core lazily for DEV=true; stub it like qca does.
  alias: { "react-devtools-core": path.resolve(__dirname, "src/shims/react-devtools-core.ts") },
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`,
  },
  define: { "process.env.CLI_VERSION": JSON.stringify(process.env.npm_package_version ?? "0.1.0") },
});
console.log("✓ bundle/pma.js");
