import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";

// Plain Vite + TanStack Router (SPA mode) — no SSR, no Cloudflare Workers
// runtime. The build output is a single static index.html plus an
// assets/ directory, which any HTTP file server (including astrolabe's
// Go binary via `http.FileServer`) can serve directly.
//
// We previously used @lovable.dev/vite-tanstack-config which targeted
// Cloudflare Workers. That produces an SSR worker bundle that needs a
// Workers runtime to render — incompatible with astrolabe's NUC
// deployment shape (Go binary, no Node, no Workers). The migration
// trades Lovable's SSR niceties for a deployment that fits the actual
// use case: an internal-only dashboard on a private network.
export default defineConfig({
  plugins: [
    TanStackRouterVite({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
