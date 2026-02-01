import express from 'express';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { LangGraphTestRunner, loadPlan, savePlan, findPlanStep, upsertPlanStep, ExecutionPlan } from './langgraph-runner.js';
import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

config();

// Memory state file path (should match langgraph-runner.ts)
const MEMORY_FILE_PATH = './.memory-state.json';

/**
 * Clear memory state file on startup
 */
function clearMemoryState(): void {
  try {
    if (fs.existsSync(MEMORY_FILE_PATH)) {
      fs.writeFileSync(MEMORY_FILE_PATH, '{}', 'utf-8');
      console.log('🧹 Memory state cleared on startup');
    }
  } catch (e) {
    console.warn('⚠️ Could not clear memory state:', e);
  }
}

// Clear memory state when the server starts
clearMemoryState();

// MCP Server URLs for dual-browser setup
const MCP_URLS: { [key: number]: string } = {
  1: 'http://localhost:8932/mcp',
  2: 'http://localhost:8933/mcp'
};

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

app.use(express.json());
app.use(express.static('public'));

interface TestExecution {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime?: Date;
  endTime?: Date;
  results?: any[];
  logs: string[];
}

const activeTests = new Map<string, TestExecution>();

// Single shared persistent runner for all browsers
// This maintains MCP connections across single-step executions
let sharedRunner: LangGraphTestRunner | null = null;
let runnerInitialized = false;

/**
 * Get or create the shared persistent runner
 * This ensures MCP connections stay open across multiple single-step executions
 */
async function getSharedRunner(): Promise<LangGraphTestRunner> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set');
  }

  // Create runner if it doesn't exist
  if (!sharedRunner) {
    console.log(`🔧 Creating shared persistent runner...`);
    sharedRunner = new LangGraphTestRunner(apiKey);
  }

  // Initialize MCP connections if not yet connected
  if (!runnerInitialized) {
    console.log(`🔌 Initializing MCP connections...`);
    await sharedRunner.initializeMCP();
    runnerInitialized = true;
    console.log(`✅ MCP connections ready`);
  }

  return sharedRunner;
}

/**
 * Reset the shared runner (close MCP and clear instance)
 */
async function resetSharedRunner(): Promise<void> {
  if (sharedRunner) {
    console.log(`🔄 Resetting shared runner...`);
    try {
      await sharedRunner.closeMCP();
    } catch (e) {
      console.warn(`⚠️ Error closing MCP:`, e);
    }
    sharedRunner = null;
    runnerInitialized = false;
  }
}

// Browser state - simplified for dual MCP server setup
interface BrowserState {
  url: string;
  connected: boolean;
}

const browsers: { [key: number]: BrowserState } = {
  1: { url: 'https://latower.ch', connected: false },
  2: { url: 'https://latower.ch', connected: false },
};

// Parse CLI arguments for URLs
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url1' && args[i + 1]) {
    browsers[1].url = args[i + 1];
    i++;
  } else if (args[i] === '--url2' && args[i + 1]) {
    browsers[2].url = args[i + 1];
    i++;
  }
}

// Export browsers for use in runner
export function getBrowserState(browserNum: number): BrowserState | undefined {
  return browsers[browserNum];
}

// Get list of test scenarios
app.get('/api/scenarios', (req, res) => {
  const scenariosDir = path.join(process.cwd(), 'scenarios');
  try {
    const files = fs.readdirSync(scenariosDir)
      .filter(f => f.endsWith('.txt') && !f.startsWith('.')) // Hide hidden files (temp file)
      .map(f => ({
        name: f,
        path: `scenarios/${f}`,
        content: fs.readFileSync(path.join(scenariosDir, f), 'utf-8'),
      }));
    res.json(files);
  } catch (error) {
    res.json([]);
  }
});

// Save a test scenario
app.post('/api/scenarios', (req, res) => {
  const { name, content } = req.body;
  const scenariosDir = path.join(process.cwd(), 'scenarios');
  const filePath = path.join(scenariosDir, name);

  try {
    if (!fs.existsSync(scenariosDir)) {
      fs.mkdirSync(scenariosDir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ success: true, path: `scenarios/${name}` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save scenario' });
  }
});

// Run a test
app.post('/api/run-test', async (req, res) => {
  const { scenario, url, startBrowser } = req.body;
  const testId = Date.now().toString();

  const testExecution: TestExecution = {
    id: testId,
    status: 'pending',
    logs: [],
  };

  activeTests.set(testId, testExecution);
  res.json({ testId });

  // Run test in background
  runTest(testId, scenario, url || 'https://latower.ch', startBrowser ?? true);
});

// Initialize browsers endpoint - opens fresh windows and resets session
app.post('/api/init-browsers', async (req, res) => {
  const { url1, url2 } = req.body;

  if (url1) browsers[1].url = url1;
  if (url2) browsers[2].url = url2;

  try {
    // Reset existing runner first (clears old MCP connections)
    await resetSharedRunner();

    // Clear memory state when initializing browsers (fresh session)
    clearMemoryState();

    // Get shared runner and initialize browsers
    const runner = await getSharedRunner();

    if (url1) {
      console.log(`🌐 Initializing Browser 1 with ${url1}...`);
      await runner.initializeBrowser(1, url1);
      browsers[1].connected = true;
      console.log(`✅ Browser 1 initialized with ${url1}`);
    }

    if (url2) {
      console.log(`🌐 Initializing Browser 2 with ${url2}...`);
      await runner.initializeBrowser(2, url2);
      browsers[2].connected = true;
      console.log(`✅ Browser 2 initialized with ${url2}`);
    }

    // NOTE: We do NOT close MCP here - persistent runners stay connected!

    io.emit('browsers-initialized', {
      browser1: { url: browsers[1].url, connected: browsers[1].connected },
      browser2: { url: browsers[2].url, connected: browsers[2].connected },
    });

    res.json({
      success: true,
      browser1: { url: browsers[1].url, connected: browsers[1].connected },
      browser2: { url: browsers[2].url, connected: browsers[2].connected },
      message: 'Browsers initialized with fresh windows and clean sessions.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Browser initialization failed:', errorMessage);
    res.status(500).json({ error: errorMessage });
  }
});

// Get browser state
app.get('/api/browsers', (req, res) => {
  res.json({
    browser1: browsers[1],
    browser2: browsers[2],
    // Include runner connection status
    runnerInitialized,
  });
});

// Reset shared runner endpoint - closes MCP connections and clears runner instance
app.post('/api/reset-runners', async (req, res) => {
  try {
    await resetSharedRunner();
    res.json({ success: true, message: 'Runner reset' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: errorMessage });
  }
});

// Run a single instruction line
app.post('/api/run-single', async (req, res) => {
  const { instruction } = req.body;
  const testId = Date.now().toString();

  const testExecution: TestExecution = {
    id: testId,
    status: 'pending',
    logs: [],
  };

  activeTests.set(testId, testExecution);
  res.json({ testId });

  // Run single instruction in background with browser context
  runSingleInstruction(testId, instruction);
});

// Get test status
app.get('/api/test-status/:id', (req, res) => {
  const test = activeTests.get(req.params.id);
  if (!test) {
    res.status(404).json({ error: 'Test not found' });
    return;
  }
  res.json(test);
});

// Reset session endpoint
app.post('/api/reset-session', async (req, res) => {
  const { browserNum = 1 } = req.body;

  try {
    // Import dynamically to avoid circular dependencies
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

    const mcpUrl = MCP_URLS[browserNum as 1 | 2] || MCP_URLS[1];
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    const mcpClient = new Client(
      { name: 'e2e-session-reset', version: '1.0.0' },
      { capabilities: {} }
    );

    await mcpClient.connect(transport);

    // Call browser_evaluate to clear localStorage and sessionStorage
    await mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: '() => { localStorage.clear(); sessionStorage.clear(); }' }
    });

    await mcpClient.close();

    res.json({ success: true, message: `Session reset successfully on browser ${browserNum}` });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: errorMessage });
  }
});

// ===== Plan Management Endpoints =====

const PLANS_DIR = path.join(process.cwd(), 'plans');

// List all saved plans
app.get('/api/plans', (req, res) => {
  try {
    if (!fs.existsSync(PLANS_DIR)) {
      return res.json([]);
    }
    const files = fs.readdirSync(PLANS_DIR)
      .filter(f => f.endsWith('.plan.json'))
      .map(f => {
        const content = JSON.parse(fs.readFileSync(path.join(PLANS_DIR, f), 'utf-8'));
        return {
          name: f,
          scenarioName: content.scenarioName,
          stepsCount: content.steps?.length || 0,
          learnedCount: content.steps?.filter((s: any) => s.learnedAt).length || 0,
          createdAt: content.createdAt,
          updatedAt: content.updatedAt,
        };
      });
    res.json(files);
  } catch (error) {
    res.json([]);
  }
});

// Get a specific plan
app.get('/api/plans/:name', (req, res) => {
  try {
    const planPath = path.join(PLANS_DIR, req.params.name + '.plan.json');
    if (!fs.existsSync(planPath)) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    const content = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read plan' });
  }
});

// Delete a plan
app.delete('/api/plans/:name', (req, res) => {
  try {
    const planPath = path.join(PLANS_DIR, req.params.name + '.plan.json');
    if (fs.existsSync(planPath)) {
      fs.unlinkSync(planPath);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

// Learn a single line (run with LLM, capture plan step)
app.post('/api/learn-single', async (req, res) => {
  const { instruction, scenarioName } = req.body;
  const testId = Date.now().toString();

  const testExecution: TestExecution = {
    id: testId,
    status: 'pending',
    logs: [],
  };

  activeTests.set(testId, testExecution);
  res.json({ testId });

  // Run learning in background
  runLearnSingleInstruction(testId, instruction, scenarioName);
});

async function runLearnSingleInstruction(testId: string, instruction: string, scenarioName: string) {
  const test = activeTests.get(testId)!;
  test.status = 'running';
  test.startTime = new Date();

  const emitLog = (message: string) => {
    test.logs.push(message);
    io.emit('test-log', { testId, message });
  };

  try {
    const { browserNum, cleanInstruction } = parseBrowserPrefix(instruction);

    emitLog(`📚 Learning on Browser ${browserNum}: ${cleanInstruction.substring(0, 60)}...`);

    // Intercept console
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args) => { const m = args.join(' '); emitLog(m); originalLog(...args); };
    console.warn = (...args) => { const m = '⚠️ ' + args.join(' '); emitLog(m); originalWarn(...args); };
    console.error = (...args) => { const m = '❌ ' + args.join(' '); emitLog(m); originalError(...args); };

    const runner = await getSharedRunner();
    const { result, planStep } = await runner.runSingleStepLearning(
      cleanInstruction, browserNum as 1 | 2
    );

    // Restore console
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;

    // Save plan step — use the full original instruction (with browser prefix) as the key
    if (planStep && scenarioName) {
      planStep.originalInstruction = instruction.trim();
      let plan = loadPlan(scenarioName);
      if (!plan) {
        plan = {
          scenarioName,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          steps: [],
        };
      }
      upsertPlanStep(plan, planStep);
      savePlan(plan);
      emitLog(`📋 Plan updated for ${scenarioName}`);
    }

    test.status = 'completed';
    test.endTime = new Date();
    test.results = [result];

    io.emit('single-line-result', { testId, result });
    io.emit('plan-updated', { scenarioName });
    emitLog(`\n${result.success ? '✅' : '❌'} ${result.actualResult}`);
  } catch (error) {
    test.status = 'failed';
    test.endTime = new Date();
    const errorMessage = error instanceof Error ? error.message : String(error);
    emitLog(`\n❌ Error: ${errorMessage}`);
    io.emit('single-line-result', {
      testId,
      result: {
        instruction: instruction.split('>>>')[0]?.trim() || instruction,
        expectedResult: instruction.split('>>>')[1]?.trim() || '',
        actualResult: `Error: ${errorMessage}`,
        success: false,
      }
    });
  }
}

// Run a single line using plan (replay with fallback)
app.post('/api/run-single-plan', async (req, res) => {
  const { instruction, scenarioName } = req.body;
  const testId = Date.now().toString();

  const testExecution: TestExecution = {
    id: testId,
    status: 'pending',
    logs: [],
  };

  activeTests.set(testId, testExecution);
  res.json({ testId });

  // Run plan execution in background
  runPlanSingleInstruction(testId, instruction, scenarioName);
});

async function runPlanSingleInstruction(testId: string, instruction: string, scenarioName: string) {
  const test = activeTests.get(testId)!;
  test.status = 'running';
  test.startTime = new Date();

  const emitLog = (message: string) => {
    test.logs.push(message);
    io.emit('test-log', { testId, message });
  };

  try {
    const { browserNum, cleanInstruction } = parseBrowserPrefix(instruction);
    const plan = loadPlan(scenarioName);

    emitLog(`⚡ Running with plan on Browser ${browserNum}: ${cleanInstruction.substring(0, 60)}...`);

    // Intercept console
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args) => { const m = args.join(' '); emitLog(m); originalLog(...args); };
    console.warn = (...args) => { const m = '⚠️ ' + args.join(' '); emitLog(m); originalWarn(...args); };
    console.error = (...args) => { const m = '❌ ' + args.join(' '); emitLog(m); originalError(...args); };

    const runner = await getSharedRunner();
    // Pass full instruction (with browser prefix) for plan step matching
    const { result, updatedPlanStep, planUpdated } = await runner.runSingleStepWithPlan(
      cleanInstruction, browserNum as 1 | 2, plan, false, instruction.trim()
    );

    // Restore console
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;

    // Update plan if it changed (fallback occurred)
    if (planUpdated && updatedPlanStep && scenarioName) {
      updatedPlanStep.originalInstruction = instruction.trim();
      let currentPlan = loadPlan(scenarioName) || {
        scenarioName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [],
      };
      upsertPlanStep(currentPlan, updatedPlanStep);
      savePlan(currentPlan);
      emitLog(`📋 Plan updated (fallback triggered)`);
      io.emit('plan-updated', { scenarioName });
    }

    test.status = 'completed';
    test.endTime = new Date();
    test.results = [result];

    io.emit('single-line-result', { testId, result });
    emitLog(`\n${result.success ? '✅' : '❌'} ${result.actualResult}`);
  } catch (error) {
    test.status = 'failed';
    test.endTime = new Date();
    const errorMessage = error instanceof Error ? error.message : String(error);
    emitLog(`\n❌ Error: ${errorMessage}`);
    io.emit('single-line-result', {
      testId,
      result: {
        instruction: instruction.split('>>>')[0]?.trim() || instruction,
        expectedResult: instruction.split('>>>')[1]?.trim() || '',
        actualResult: `Error: ${errorMessage}`,
        success: false,
      }
    });
  }
}

// Parse browser prefix from instruction (*1 or *2)
function parseBrowserPrefix(instruction: string): { browserNum: number; cleanInstruction: string } {
  const match = instruction.match(/^\*([12])\s+/);
  if (match) {
    return {
      browserNum: parseInt(match[1]),
      cleanInstruction: instruction.substring(match[0].length),
    };
  }
  // Default to browser 1
  return { browserNum: 1, cleanInstruction: instruction };
}

// Check if instruction is a special command (no >>> needed)
interface SpecialCommand {
  type: 'navigate' | 'reset' | 'scroll' | 'none';
  url?: string;
  direction?: 'down' | 'up';
}

function parseSpecialCommand(instruction: string): SpecialCommand {
  // Match "go to <url>" or "navigate to <url>"
  const navMatch = instruction.match(/^(?:go\s+to|navigate\s+to)\s+(.+)$/i);
  if (navMatch) {
    return { type: 'navigate', url: navMatch[1].trim() };
  }

  // Match "reset session" or "reset storage" or "clear session" or "clear storage"
  const resetMatch = instruction.match(/^(?:reset|clear)\s+(?:session|storage|localstorage)$/i);
  if (resetMatch) {
    return { type: 'reset' };
  }

  // Match "scroll down" or "scroll up"
  const scrollMatch = instruction.match(/^scroll\s+(down|up)$/i);
  if (scrollMatch) {
    return { type: 'scroll', direction: scrollMatch[1].toLowerCase() as 'down' | 'up' };
  }

  return { type: 'none' };
}

async function runSingleInstruction(testId: string, instruction: string) {
  const test = activeTests.get(testId)!;
  test.status = 'running';
  test.startTime = new Date();

  const emitLog = (message: string) => {
    test.logs.push(message);
    io.emit('test-log', { testId, message });
  };

  try {
    // Parse browser prefix
    const { browserNum, cleanInstruction } = parseBrowserPrefix(instruction);
    const browser = browsers[browserNum];

    emitLog(`🎯 Running on Browser ${browserNum} (${browser.url})...`);

    // Check for special commands
    const specialCmd = parseSpecialCommand(cleanInstruction);

    if (specialCmd.type !== 'none') {
      // Handle special commands directly via MCP
      await executeSpecialCommand(specialCmd, browserNum, browser, emitLog);

      test.status = 'completed';
      test.endTime = new Date();

      let actualResult = '';
      if (specialCmd.type === 'navigate') {
        actualResult = `Navigated to ${specialCmd.url}`;
      } else if (specialCmd.type === 'reset') {
        actualResult = 'Session/storage cleared and page reloaded';
      } else if (specialCmd.type === 'scroll') {
        actualResult = `Scrolled ${specialCmd.direction}`;
      }

      const result = {
        instruction: cleanInstruction,
        expectedResult: '',
        actualResult,
        success: true,
      };

      test.results = [result];
      io.emit('single-line-result', { testId, result });
      emitLog(`\n✅ ${result.actualResult}`);
      return;
    }

    // Regular instruction with >>> - use persistent LangGraph runner
    emitLog(`📝 ${cleanInstruction}`);

    // Intercept console.log to capture logs
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args) => {
      const message = args.join(' ');
      emitLog(message);
      originalLog(...args);
    };
    console.warn = (...args) => {
      const message = '⚠️ ' + args.join(' ');
      emitLog(message);
      originalWarn(...args);
    };
    console.error = (...args) => {
      const message = '❌ ' + args.join(' ');
      emitLog(message);
      originalError(...args);
    };

    // Get shared runner (maintains MCP connection across steps)
    const runner = await getSharedRunner();

    // Run single step without closing MCP connection
    const result = await runner.runSingleStep(cleanInstruction, browserNum as 1 | 2);

    // Restore console
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;

    test.status = 'completed';
    test.endTime = new Date();
    test.results = [result];

    io.emit('single-line-result', { testId, result });
    emitLog(`\n${result.success ? '✅' : '❌'} ${result.actualResult}`);
  } catch (error) {
    test.status = 'failed';
    test.endTime = new Date();
    const errorMessage = error instanceof Error ? error.message : String(error);
    emitLog(`\n❌ Error: ${errorMessage}`);
    io.emit('single-line-result', {
      testId,
      result: {
        instruction: instruction.split('>>>')[0]?.trim() || instruction,
        expectedResult: instruction.split('>>>')[1]?.trim() || '',
        actualResult: `Error: ${errorMessage}`,
        success: false,
      }
    });
  }
}

// Execute special commands directly via MCP (uses per-browser MCP server)
async function executeSpecialCommand(
  cmd: SpecialCommand,
  browserNum: number,
  browser: BrowserState,
  emitLog: (msg: string) => void
): Promise<void> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

  const mcpUrl = MCP_URLS[browserNum as 1 | 2] || MCP_URLS[1];
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  const mcpClient = new Client(
    { name: 'e2e-special-cmd', version: '1.0.0' },
    { capabilities: {} }
  );

  await mcpClient.connect(transport);

  emitLog(`📍 Using MCP server for browser ${browserNum}`);

  try {
    if (cmd.type === 'navigate' && cmd.url) {
      emitLog(`🔗 Navigating to ${cmd.url}...`);

      await mcpClient.callTool({
        name: 'browser_navigate',
        arguments: { url: cmd.url }
      });

      // Update stored URL so reset uses the correct page
      browser.url = cmd.url;

      // Wait for page to load
      await new Promise(resolve => setTimeout(resolve, 2000));
      emitLog(`✅ Navigation complete`);

    } else if (cmd.type === 'reset') {
      emitLog(`🔄 Clearing session/storage...`);

      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: '() => { localStorage.clear(); sessionStorage.clear(); }' }
      });

      emitLog(`✅ Session/storage cleared`);

      // Reload page
      emitLog(`🔄 Reloading page...`);
      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: '() => { location.reload(); }' }
      });

      // Wait for page to reload
      await new Promise(resolve => setTimeout(resolve, 2000));
      emitLog(`✅ Page reloaded`);

    } else if (cmd.type === 'scroll') {
      const direction = cmd.direction || 'down';
      emitLog(`📜 Scrolling ${direction}...`);

      const scrollCode = direction === 'down'
        ? '() => { window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" }); }'
        : '() => { window.scrollBy({ top: -window.innerHeight * 0.8, behavior: "smooth" }); }';

      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: scrollCode }
      });

      // Wait for scroll animation
      await new Promise(resolve => setTimeout(resolve, 500));
      emitLog(`✅ Scrolled ${direction}`);
    }
  } finally {
    await mcpClient.close();
  }
}

async function runTest(testId: string, scenarioContent: string, url: string, startBrowser: boolean) {
  const test = activeTests.get(testId)!;
  test.status = 'running';
  test.startTime = new Date();

  const emitLog = (message: string) => {
    test.logs.push(message);
    io.emit('test-log', { testId, message });
  };

  const emitProgress = (data: any) => {
    io.emit('test-progress', { testId, ...data });
  };

  try {
    // Use a single temporary test file (hidden with dot prefix)
    const tempFile = path.join(process.cwd(), 'scenarios', '.temp-test.txt');
    fs.writeFileSync(tempFile, scenarioContent, 'utf-8');

    emitLog(`🧪 Starting test execution...`);
    emitLog(`📍 Target URL: ${url}`);
    emitLog(`🌐 Start Browser: ${startBrowser ? 'Yes (navigate to URL)' : 'No (use existing tab)'}`);

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY not set');
    }

    // Intercept console.log to capture logs
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args) => {
      const message = args.join(' ');
      emitLog(message);
      originalLog(...args);
    };
    console.warn = (...args) => {
      const message = '⚠️ ' + args.join(' ');
      emitLog(message);
      originalWarn(...args);
    };
    console.error = (...args) => {
      const message = '❌ ' + args.join(' ');
      emitLog(message);
      originalError(...args);
    };

    const runner = new LangGraphTestRunner(apiKey);
    // Default to browser 1 for test runs, with optional starting URL
    const finalState = await runner.runTestSuite(tempFile, 1, startBrowser ? url : null);

    // Restore console
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;

    // No cleanup - reuse the same temp file for next test

    test.status = 'completed';
    test.endTime = new Date();
    test.results = finalState.results;

    emitProgress({
      status: 'completed',
      results: finalState.results,
      summary: {
        total: finalState.results.length,
        passed: finalState.results.filter((r: any) => r.success).length,
        failed: finalState.results.filter((r: any) => !r.success).length,
      },
    });

    emitLog(`\n✅ Test execution completed`);
  } catch (error) {
    test.status = 'failed';
    test.endTime = new Date();
    const errorMessage = error instanceof Error ? error.message : String(error);
    emitLog(`\n❌ Test failed: ${errorMessage}`);
    emitProgress({ status: 'failed', error: errorMessage });
  }
}

const PORT = process.env.PORT || 3002;
httpServer.listen(PORT, () => {
  console.log(`\n🌐 E2E Test Runner Web UI started`);
  console.log(`📍 Open http://localhost:${PORT} in your browser\n`);
});
