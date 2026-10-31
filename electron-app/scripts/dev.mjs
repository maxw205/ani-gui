// `npm run dev`: starts Vite's dev server (hot reload for the React side) and opens
// Electron on it. Closing the window stops both.
import { spawn } from "node:child_process";
import electron from "electron";
import { createServer } from "vite";

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`Vite dev server at ${url}`);

const app = spawn(electron, ["."], { stdio: "inherit", env: { ...process.env, ELECTRON_RENDERER_URL: url } });
app.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
