import { build, type Plugin } from "esbuild";

// Vercel compiles each traced .ts file to .js but leaves package.json
// `exports` naming the .ts, so a function importing the workspace packages
// (which export TypeScript source) fails to resolve them at runtime. They are
// bundled into dist/server.js instead; npm packages stay external, for Vercel
// to trace from node_modules (the libSQL driver loads a native binding). The
// Hono preset serves the default export of app, index or server in vercel.json's
// outputDirectory only if its source imports from "hono", as it does while hono
// stays external.
const npmPackagesExternal: Plugin = {
  name: "npm-packages-external",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, ({ path }) =>
      path.startsWith("@nonprofits/") ? undefined : { external: true },
    );
  },
};

await build({
  entryPoints: ["server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  plugins: [npmPackagesExternal],
  logLevel: "warning",
});
