import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Only allow what the app needs. Added to the built page only: Vite's dev server injects
// inline scripts (React refresh) that this policy would block.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://s4.anilist.co",
  "connect-src 'self' anistream: https://graphql.anilist.co",
  "media-src 'self' blob: anistream:",
].join("; ");

const contentSecurityPolicy = {
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<head>", `<head>\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
};

export default defineConfig({
  // the built page is loaded from disk (file://), so asset paths must be relative
  base: "./",
  plugins: [react(), contentSecurityPolicy],
  // hls.js alone is ~500 kB; a desktop app loading from disk doesn't need it split up
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173, strictPort: true },
});
