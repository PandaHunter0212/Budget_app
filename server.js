#!/usr/bin/env node

/**
 * Budget App Development Server
 * Simple HTTP server for testing the Budget App with device detection
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// MIME types
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

const server = http.createServer((req, res) => {
  // Parse the request URL
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  // Remove trailing slash if it's not root
  if (pathname !== '/' && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // Default to index.html for directory requests
  if (pathname === '' || pathname === '/') {
    pathname = '/index.html';
  }

  // Build file path
  let filePath = path.join(__dirname, 'Budget_app', pathname);

  // Security: prevent directory traversal
  const realPath = path.resolve(filePath);
  const basePath = path.resolve(path.join(__dirname, 'Budget_app'));
  
  if (!realPath.startsWith(basePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  // Check if path is a directory, try index.html
  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch (err) {
    // File doesn't exist, will handle below
  }

  // Read and serve the file
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404 Not Found: ${pathname}`);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`500 Server Error: ${err.message}`);
      }
      return;
    }

    // Get file extension
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Set cache headers for static assets
    if (ext === '.html') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║     Budget App Development Server Started     ║
╚════════════════════════════════════════════════╝

📱 Server is running on:
   http://localhost:${PORT}

🌐 Access from other machines:
   http://<your-ip>:${PORT}

📋 Test URLs:
   • Main (Auto-detect):    http://localhost:${PORT}/
   • Computer version:      http://localhost:${PORT}/Computer/
   • Mobile version:        http://localhost:${PORT}/Mobile/

💡 Tips for testing device detection:
   • Open DevTools (F12) → Toggle Device Toolbar (Ctrl+Shift+M)
   • Select different devices (iPhone, iPad, Android, etc.)
   • Refresh the page to see automatic redirect

⚠️  Press Ctrl+C to stop the server

Serving from: ${path.join(__dirname, 'Budget_app')}
  `);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use!`);
    console.error(`Try: PORT=3001 node server.js`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});
