// Electron main process: the window, ani-cli sessions (anicli.cjs) and the stream proxy
// (stream.cjs). The page reaches these only through the small API in preload.cjs.

const path = require("node:path");
const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const { AniCli } = require("./anicli.cjs");
const { StreamProxy } = require("./stream.cjs");

// must happen before the app is ready: anistream:// behaves like https for fetch and media
protocol.registerSchemesAsPrivileged([
  { scheme: "anistream", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// Chromium leaves WebGPU (the upscaler) off on Linux unless asked; it falls back to plain video if it still fails
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-unsafe-webgpu");
  app.commandLine.appendSwitch("enable-features", "Vulkan");
}

let win = null;
let anicli = null;
const streams = new StreamProxy();

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    title: "AnimeCLI",
    backgroundColor: "#15161c",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  anicli = new AniCli({
    send: (channel, payload) => win?.webContents.send(channel, payload),
    dataDir: app.getPath("userData"),
    streams,
  });
  protocol.handle("anistream", (request) => streams.handle(request));

  ipcMain.handle("ani:start", (_e, { id, args }) => anicli.start(id, args));
  ipcMain.handle("ani:answer", (_e, { session, text }) => anicli.answer(session, text));
  ipcMain.handle("ani:finish", (_e, { session }) => anicli.finish(session));
  ipcMain.handle("ani:stop", () => anicli.stop());
  ipcMain.handle("ani:history", () => anicli.history());
  ipcMain.handle("ani:environment", () => anicli.environment());

  createWindow();
});

app.on("window-all-closed", () => {
  anicli?.stop();
  app.quit();
});
