import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Colors for terminal output
const colors = {
  mcp1: '\x1b[36m',    // Cyan
  mcp2: '\x1b[35m',    // Magenta
  ui: '\x1b[32m',      // Green
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

function log(prefix, color, message) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${colors.dim}${timestamp}${colors.reset} ${color}[${prefix}]${colors.reset} ${message}`);
}

// Path to the mcp-server-playwright binary in node_modules
const playwrightMcpBin = join(__dirname, 'node_modules', '.bin', 'mcp-server-playwright');

// MCP Server 1 (Browser 1 - port 8932)
const mcp1 = spawn(playwrightMcpBin, [
  '--port', '8932',
  '--host', '0.0.0.0',
  '--ignore-https-errors',
  '--allowed-hosts=*',
  '--browser', 'chrome',
  '--user-data-dir', './user_dir',
  '--storage-state', './storage_state',
  '--shared-browser-context'
], {
  cwd: __dirname,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env }
});

mcp1.stdout.on('data', (data) => {
  data.toString().trim().split('\n').forEach(line => {
    if (line) log('MCP-1', colors.mcp1, line);
  });
});

mcp1.stderr.on('data', (data) => {
  data.toString().trim().split('\n').forEach(line => {
    if (line) log('MCP-1', colors.mcp1, line);
  });
});

// MCP Server 2 (Browser 2 - port 8933)
const mcp2 = spawn(playwrightMcpBin, [
  '--port', '8933',
  '--host', '0.0.0.0',
  '--ignore-https-errors',
  '--allowed-hosts=*',
  '--browser', 'chrome',
  '--user-data-dir', './user_dir_2',
  '--storage-state', './storage_state_2',
  '--shared-browser-context'
], {
  cwd: __dirname,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env }
});

mcp2.stdout.on('data', (data) => {
  data.toString().trim().split('\n').forEach(line => {
    if (line) log('MCP-2', colors.mcp2, line);
  });
});

mcp2.stderr.on('data', (data) => {
  data.toString().trim().split('\n').forEach(line => {
    if (line) log('MCP-2', colors.mcp2, line);
  });
});

// Wait for MCP servers to start, then launch the web UI
log('MAIN', colors.ui, 'Starting MCP servers...');

setTimeout(() => {
  log('MAIN', colors.ui, 'Starting Web UI...');

  const tsxBin = join(__dirname, 'node_modules', '.bin', 'tsx');
  const ui = spawn(tsxBin, ['web-ui.ts'], {
    cwd: __dirname,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  ui.stdout.on('data', (data) => {
    data.toString().trim().split('\n').forEach(line => {
      if (line) log('UI', colors.ui, line);
    });
  });

  ui.stderr.on('data', (data) => {
    data.toString().trim().split('\n').forEach(line => {
      if (line) log('UI', colors.ui, line);
    });
  });

  ui.on('close', (code) => {
    log('MAIN', colors.ui, `Web UI exited with code ${code}`);
    cleanup();
  });
}, 3000);

// Cleanup on exit
function cleanup() {
  log('MAIN', colors.reset, 'Shutting down...');
  mcp1.kill();
  mcp2.kill();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

mcp1.on('close', (code) => {
  log('MCP-1', colors.mcp1, `Exited with code ${code}`);
});

mcp2.on('close', (code) => {
  log('MCP-2', colors.mcp2, `Exited with code ${code}`);
});

log('MAIN', colors.ui, '🚀 FlowSpec starting...');
log('MAIN', colors.ui, '   MCP Server 1: http://localhost:8932/mcp');
log('MAIN', colors.ui, '   MCP Server 2: http://localhost:8933/mcp');
log('MAIN', colors.ui, '   Web UI: http://localhost:3002 (starting in 3s...)');
