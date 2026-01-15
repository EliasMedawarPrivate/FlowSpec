import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Browser state management for dual Playwright MCP server setup
 *
 * With the new setup, each browser has its own MCP server:
 * - Browser 1: http://localhost:8932/mcp
 * - Browser 2: http://localhost:8933/mcp
 *
 * No need for tabId/windowId tracking since each server controls one browser.
 */

// MCP Server URLs for dual-browser setup
const MCP_URLS: { [key in 1 | 2]: string } = {
  1: 'http://localhost:8932/mcp',
  2: 'http://localhost:8933/mcp'
};

export interface BrowserInfo {
  url: string;
  lastVerified: string; // ISO timestamp
}

export interface BrowserStateFile {
  browser1?: BrowserInfo;
  browser2?: BrowserInfo;
  lastUpdated: string;
}

const STATE_FILE_PATH = path.join(process.cwd(), '.browser-state.json');

/**
 * Get MCP URL for a specific browser
 */
export function getMcpUrl(browserNum: 1 | 2): string {
  return MCP_URLS[browserNum];
}

/**
 * Load browser state from file
 */
export function loadBrowserState(): BrowserStateFile | null {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const content = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {
    console.warn('⚠️ Could not load browser state file:', e);
  }
  return null;
}

/**
 * Save browser state to file
 */
export function saveBrowserState(state: BrowserStateFile): void {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    console.log('💾 Browser state saved to file');
  } catch (e) {
    console.warn('⚠️ Could not save browser state file:', e);
  }
}

/**
 * Update a single browser's state
 */
export function updateBrowserState(browserNum: 1 | 2, info: Partial<BrowserInfo>): void {
  const state = loadBrowserState() || { lastUpdated: new Date().toISOString() };
  const key = browserNum === 1 ? 'browser1' : 'browser2';

  state[key] = {
    ...state[key],
    ...info,
    lastVerified: new Date().toISOString(),
  } as BrowserInfo;

  saveBrowserState(state);
}

/**
 * Get tabs from browser via MCP browser_tabs tool
 */
export async function getTabs(mcpClient: Client): Promise<any> {
  try {
    const result = await mcpClient.callTool({
      name: 'browser_tabs',
      arguments: { action: 'list' }
    });

    if (result.content && Array.isArray(result.content)) {
      const textContent = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      try {
        return JSON.parse(textContent);
      } catch (e) {
        return null;
      }
    }
    return null;
  } catch (e) {
    console.warn('⚠️ Could not get tabs:', e);
    return null;
  }
}

/**
 * Create a new MCP client connection for a specific browser
 */
export async function createMcpClient(browserNum: 1 | 2): Promise<Client> {
  const mcpUrl = getMcpUrl(browserNum);
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  const mcpClient = new Client(
    { name: `e2e-browser-state-${browserNum}`, version: '1.0.0' },
    { capabilities: {} }
  );
  await mcpClient.connect(transport);
  return mcpClient;
}

/**
 * Verify browser is connected by getting a snapshot
 */
export async function verifyBrowserConnected(browserNum: 1 | 2): Promise<boolean> {
  try {
    const mcpClient = await createMcpClient(browserNum);

    // Try to get a snapshot to verify connection
    await mcpClient.callTool({
      name: 'browser_snapshot',
      arguments: {}
    });

    await mcpClient.close();
    return true;
  } catch (e) {
    console.warn(`⚠️ Browser ${browserNum} not connected:`, e);
    return false;
  }
}
