// sql.js loader for BattleTask Chrome Extension
// This file loads sql.js (SQLite compiled to WebAssembly) for use in browser

// Use CDN for sql.js
export async function loadSqlJs() {
  if (window.initSqlJs) return window.initSqlJs;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js';
    script.onload = () => {
      window.initSqlJs({
        locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
      }).then(SQL => {
        resolve(SQL);
      }).catch(reject);
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}
