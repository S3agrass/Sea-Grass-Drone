const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const isDev = process.env.NODE_ENV !== 'production';

// The production window loads its bundle off disk (loadFile below), so it is a
// file:// page and receives none of the response headers firebase.json sets for
// the hosted build — no CSP at all, on what is arguably the more privileged of
// the two clients. Injected here instead.
//
// Mirrors the strict /desktop/** policy in firebase.json, with one difference:
// connect-src has to stay broad because drone hosts are operator-configured
// (any wss:// or http:// address a fleet entry names), so it cannot be
// enumerated without breaking custom entries. The value of this policy is
// script-src/object-src/base-uri, which is what contains an injected script.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob: https: http:",
  "connect-src 'self' https: http: ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function applyCsp() {
  // Production only. Dev loads the Vite server, which injects inline scripts and
  // needs eval for HMR — `script-src 'self'` there breaks the dev window with a
  // blank page and a console full of CSP violations, and the thing being
  // protected against (a hostile script in a shipped bundle) does not apply to a
  // localhost dev server.
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a1628',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  applyCsp();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
