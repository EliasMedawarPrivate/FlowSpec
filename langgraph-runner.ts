import { StateGraph, END, START } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import * as fs from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Persistent memory file path
const MEMORY_FILE_PATH = './.memory-state.json';

// MCP Server URLs for dual-browser setup
const MCP_URL_1 = 'http://localhost:8932/mcp';
const MCP_URL_2 = 'http://localhost:8933/mcp';

/**
 * Load memory from persistent file
 */
function loadMemoryFromFile(): Map<string, any> {
  try {
    if (fs.existsSync(MEMORY_FILE_PATH)) {
      const content = fs.readFileSync(MEMORY_FILE_PATH, 'utf-8');
      const data = JSON.parse(content);
      return new Map(Object.entries(data));
    }
  } catch (e) {
    console.warn('⚠️ Could not load memory file:', e);
  }
  return new Map();
}

/**
 * Save memory to persistent file
 */
function saveMemoryToFile(memory: Map<string, any>): void {
  try {
    const data = Object.fromEntries(memory);
    fs.writeFileSync(MEMORY_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.warn('⚠️ Could not save memory file:', e);
  }
}

/**
 * LangGraph-based test runner with state management using OpenRouter
 * This provides better control over test execution flow and state
 * Uses affordable Nvidia models via OpenRouter
 */

interface TestState {
  testSteps: Array<{ instruction: string; expectedResult: string; delay: number; browserNum: 1 | 2 }>;
  currentStepIndex: number;
  results: TestResult[];
  sessionId?: string;
  pageContent?: string;
  executionHistory: string[];
  shouldContinue: boolean;
  startingUrl?: string;
  browserNum: 1 | 2; // Current step's browser (updated per step)
}

interface TestResult {
  stepIndex: number;
  instruction: string;
  expectedResult: string;
  actualResult: string;
  success: boolean;
  executedActions: string[];
  timestamp: Date;
}

export class LangGraphTestRunner {
  private model: ChatOpenAI;
  private mcpClient1: Client | null = null;
  private mcpClient2: Client | null = null;
  private memory: Map<string, any>;

  constructor(
    apiKey?: string,
    model: string = "qwen/qwen3-30b-a3b-thinking-2507"
  ) {
    const resolvedApiKey = apiKey || process.env.OPENROUTER_API_KEY;
    if (!resolvedApiKey) {
      throw new Error('API key required: provide apiKey parameter or set OPENROUTER_API_KEY environment variable');
    }
    this.model = new ChatOpenAI({
      modelName: model,
      temperature: 0.9,
      maxTokens: 4096,

      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: resolvedApiKey,
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/your-repo',
          'X-Title': 'E2E Test Runner',
        },
      },
    });
    // Load persistent memory from file
    this.memory = loadMemoryFromFile();
    console.log(`📦 Loaded ${this.memory.size} items from persistent memory`);
  }

  /**
   * Get MCP client for the specified browser
   */
  private getMcpClient(browserNum: 1 | 2): Client {
    const client = browserNum === 1 ? this.mcpClient1 : this.mcpClient2;
    if (!client) throw new Error(`MCP client ${browserNum} not initialized`);
    return client;
  }

  /**
   * Initialize MCP client connections for both browsers
   */
  async initializeMCP(): Promise<void> {
    try {
      if (!this.mcpClient1) {
        const transport1 = new StreamableHTTPClientTransport(new URL(MCP_URL_1));
        this.mcpClient1 = new Client(
          { name: 'e2e-test-runner-1', version: '1.0.0' },
          { capabilities: {} }
        );
        await this.mcpClient1.connect(transport1);
        console.log('✅ MCP client 1 connected');
      }

      if (!this.mcpClient2) {
        const transport2 = new StreamableHTTPClientTransport(new URL(MCP_URL_2));
        this.mcpClient2 = new Client(
          { name: 'e2e-test-runner-2', version: '1.0.0' },
          { capabilities: {} }
        );
        await this.mcpClient2.connect(transport2);
        console.log('✅ MCP client 2 connected');
      }
    } catch (error) {
      console.error('❌ Failed to connect to MCP server:', error);
      throw error;
    }
  }

  /**
   * Close MCP client connections
   */
  async closeMCP(): Promise<void> {
    if (this.mcpClient1) {
      await this.mcpClient1.close();
      this.mcpClient1 = null;
    }
    if (this.mcpClient2) {
      await this.mcpClient2.close();
      this.mcpClient2 = null;
    }
  }

  /**
   * Store a value in memory (persisted to file)
   */
  private storeInMemory(key: string, value: any): string {
    this.memory.set(key, value);
    saveMemoryToFile(this.memory);
    console.log(`   💾 Stored in memory: ${key} = ${JSON.stringify(value)}`);
    return `Stored ${key} in memory`;
  }

  /**
   * Read a value from memory
   */
  private readFromMemory(key: string): any {
    const value = this.memory.get(key);
    console.log(`   📖 Read from memory: ${key} = ${JSON.stringify(value)}`);
    return value;
  }

  /**
   * Extract custom delay from instruction [[delay]] syntax
   * Returns { cleanInstruction, delay } where delay defaults to 200ms
   */
  private parseDelayFromInstruction(instruction: string): { cleanInstruction: string; delay: number } {
    const delayMatch = instruction.match(/\[\[(\d+)\]\]/);
    if (delayMatch) {
      const delay = parseInt(delayMatch[1], 10);
      const cleanInstruction = instruction.replace(/\[\[\d+\]\]/, '').trim();
      return { cleanInstruction, delay };
    }
    return { cleanInstruction: instruction, delay: 200 };
  }

  /**
   * Parse browser prefix from instruction (*1 or *2)
   * Returns { browserNum, cleanInstruction }
   */
  private parseBrowserPrefix(instruction: string): { browserNum: 1 | 2; cleanInstruction: string } {
    const match = instruction.match(/^\*([12])\s+/);
    if (match) {
      return {
        browserNum: parseInt(match[1]) as 1 | 2,
        cleanInstruction: instruction.substring(match[0].length),
      };
    }
    // Default to browser 1
    return { browserNum: 1, cleanInstruction: instruction };
  }

  /**
   * Parse test file
   * Supports two formats:
   * 1. Lines with ">>>" - instruction >>> expected result (will be verified)
   * 2. Lines without ">>>" - special commands that execute without verification
   *    (e.g., "go to https://...", "reset session", "scroll down")
   *
   * Browser prefix: *1 or *2 at start of line to target specific browser
   * Custom delay syntax: [[milliseconds]] e.g., click "Submit" [[1200]] >>> form submitted
   */
  parseTestFile(filePath: string): Array<{ instruction: string; expectedResult: string; delay: number; browserNum: 1 | 2 }> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const steps: Array<{ instruction: string; expectedResult: string; delay: number; browserNum: 1 | 2 }> = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue; // Skip empty lines

      // Parse browser prefix first
      const { browserNum, cleanInstruction: withoutPrefix } = this.parseBrowserPrefix(trimmed);

      if (withoutPrefix.includes('>>>')) {
        // Standard test step with verification
        const [instructionPart, expectedResult] = withoutPrefix.split('>>>').map(s => s.trim());
        if (instructionPart && expectedResult) {
          const { cleanInstruction, delay } = this.parseDelayFromInstruction(instructionPart);
          steps.push({ instruction: cleanInstruction, expectedResult, delay, browserNum });
        }
      } else {
        // Special command without verification (auto-pass)
        // These are commands like "go to URL", "reset session", "scroll down"
        const { cleanInstruction, delay } = this.parseDelayFromInstruction(withoutPrefix);
        steps.push({
          instruction: cleanInstruction,
          expectedResult: '__AUTO_PASS__',
          delay,
          browserNum
        });
      }
    }

    return steps;
  }

  /**
   * Build the LangGraph workflow for a single test step
   * Each step runs as its own graph invocation, resetting recursion counter
   */
  private buildStepWorkflow() {
    const workflow = new StateGraph<TestState>({
      channels: {
        testSteps: { value: (prev: any, next: any) => next ?? prev },
        currentStepIndex: { value: (prev: any, next: any) => next ?? prev },
        results: { value: (prev: any, next: any) => next ?? prev },
        sessionId: { value: (prev: any, next: any) => next ?? prev },
        pageContent: { value: (prev: any, next: any) => next ?? prev },
        executionHistory: { value: (prev: any, next: any) => next ?? prev },
        shouldContinue: { value: (prev: any, next: any) => next ?? prev },
        startingUrl: { value: (prev: any, next: any) => next ?? prev },
        browserNum: { value: (prev: any, next: any) => next ?? prev },
      },
    });

    // Node 1: Read page state
    workflow.addNode('readPage', async (state: TestState) => {
      console.log('📖 Reading page content...');
      const pageContent = await this.readPage(state.sessionId!, state.browserNum);
      return {
        ...state,
        pageContent,
      };
    });

    // Node 2: Execute test step actions
    workflow.addNode('executeStep', async (state: TestState) => {
      const step = state.testSteps[state.currentStepIndex];
      console.log(`\n[${state.currentStepIndex + 1}/${state.testSteps.length}] 🔄 ${step.instruction}`);

      // Use AI to determine and execute actions
      const result = await this.executeStepActions(
        step,
        state.pageContent!,
        state.executionHistory,
        state.browserNum
      );

      return {
        ...state,
        executionHistory: [...state.executionHistory, ...result.executedActions],
      };
    });

    // Node 3: Verify expected result
    workflow.addNode('verifyStep', async (state: TestState) => {
      const step = state.testSteps[state.currentStepIndex];

      // Handle auto-pass steps (special commands without verification)
      if (step.expectedResult === '__AUTO_PASS__') {
        console.log('   ✅ Command executed (no verification required)');

        // Wait for custom delay (default 200ms for auto-pass uses 1000ms minimum)
        const waitTime = Math.max(step.delay, 200);
        console.log(`   ⏳ Waiting ${waitTime} ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        const newResults = [
          ...state.results,
          {
            stepIndex: state.currentStepIndex,
            instruction: step.instruction,
            expectedResult: '(auto-pass)',
            actualResult: 'Command executed successfully',
            success: true,
            executedActions: state.executionHistory.slice(-10),
            timestamp: new Date(),
          },
        ];

        return {
          ...state,
          results: newResults,
          shouldContinue: true,
        };
      }

      // Wait for page changes to settle (custom delay or default 200ms)
      console.log(`   ⏳ Waiting ${step.delay} ms for page to settle...`);
      await new Promise(resolve => setTimeout(resolve, step.delay));

      // Read the new page state after actions
      console.log('   📖 Reading page after actions...');
      const newPageContent = await this.readPage(state.sessionId!, state.browserNum);

      // Verify the expected result
      const verification = await this.verifyExpectedResult(
        step.expectedResult,
        newPageContent
      );

      const newResults = [
        ...state.results,
        {
          stepIndex: state.currentStepIndex,
          instruction: step.instruction,
          expectedResult: step.expectedResult,
          actualResult: verification.actualResult,
          success: verification.success,
          executedActions: state.executionHistory.slice(-10),
          timestamp: new Date(),
        },
      ];

      const statusIcon = verification.success ? '✅' : '❌';
      console.log(`   ${statusIcon} ${verification.actualResult}`);

      return {
        ...state,
        results: newResults,
        pageContent: newPageContent,
        shouldContinue: verification.success,
      };
    });

    // Define edges - simple linear flow for one step
    workflow.addEdge(START, 'readPage' as any);
    workflow.addEdge('readPage' as any, 'executeStep' as any);
    workflow.addEdge('executeStep' as any, 'verifyStep' as any);
    workflow.addEdge('verifyStep' as any, END);

    return workflow.compile();
  }

  /**
   * Initialize browser for a specific browser number
   * With the new Playwright MCP setup, each server controls one browser,
   * @param browserNum - Which browser to initialize (1 or 2)
   * @param startingUrl - URL to navigate to
   */
  async initializeBrowser(browserNum: 1 | 2, startingUrl: string | undefined): Promise<void> {
    console.log(`🌐 Initializing MCP clients...`);
    await this.initializeMCP();

    if (!startingUrl) {
      console.log(`📍 No starting URL for browser ${browserNum}`);
      return;
    }

    const mcpClient = this.getMcpClient(browserNum);

    // Step 1: Navigate to URL
    console.log(`🪟 Browser ${browserNum}: Navigating to ${startingUrl}...`);
    await mcpClient.callTool({
      name: 'browser_navigate',
      arguments: { url: startingUrl }
    });

    // Wait for page to load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 2: Reset session (clear localStorage/sessionStorage)
    console.log(`🔄 Browser ${browserNum}: Clearing session/storage...`);
    await mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: '() => { localStorage.clear(); sessionStorage.clear(); }' }
    });

    // Step 3: Reload page to apply reset
    console.log(`🔗 Browser ${browserNum}: Reloading ${startingUrl}...`);
    await mcpClient.callTool({
      name: 'browser_navigate',
      arguments: { url: startingUrl }
    });
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log(`✅ Browser ${browserNum} initialized with ${startingUrl}`);
  }

  /**
   * Generate Mermaid diagram of the workflow
   */
  async generateWorkflowDiagram(): Promise<string> {
    const app = this.buildStepWorkflow();
    const diagram = app.getGraph().drawMermaid();
    return diagram;
  }

  /**
   * Save workflow diagram to file
   */
  async saveWorkflowDiagram(outputPath: string): Promise<void> {
    const diagram = await this.generateWorkflowDiagram();
    fs.writeFileSync(outputPath, diagram, 'utf-8');
    console.log(`📊 Workflow diagram saved to: ${outputPath}`);
  }

  /**
   * Run a single test step without closing MCP connection
   * This is used by the web UI for single-step execution to maintain browser session
   * @param instruction - Single instruction line (with >>> expected result)
   * @param browserNum - Which browser to run on (1 or 2)
   */
  async runSingleStep(instruction: string, browserNum: 1 | 2 = 1): Promise<TestResult> {
    // Parse the instruction
    const trimmed = instruction.trim();
    let step: { instruction: string; expectedResult: string; delay: number; browserNum: 1 | 2 };

    if (trimmed.includes('>>>')) {
      const [instructionPart, expectedResult] = trimmed.split('>>>').map(s => s.trim());
      const { cleanInstruction, delay } = this.parseDelayFromInstruction(instructionPart);
      step = { instruction: cleanInstruction, expectedResult, delay, browserNum };
    } else {
      const { cleanInstruction, delay } = this.parseDelayFromInstruction(trimmed);
      step = { instruction: cleanInstruction, expectedResult: '__AUTO_PASS__', delay, browserNum };
    }

    console.log(`\n🔄 Running single step on Browser ${browserNum}: ${step.instruction}`);

    // Build and run the step workflow
    const stepApp = this.buildStepWorkflow();

    const initialState: TestState = {
      testSteps: [step],
      currentStepIndex: 0,
      results: [],
      executionHistory: [],
      shouldContinue: true,
      sessionId: 'mcp-session',
      browserNum,
    };

    const finalState = await stepApp.invoke(initialState as any, {
      recursionLimit: 25,
    });

    const result = (finalState as unknown as TestState).results[0] || {
      stepIndex: 0,
      instruction: step.instruction,
      expectedResult: step.expectedResult,
      actualResult: 'No result',
      success: false,
      executedActions: [],
      timestamp: new Date(),
    };

    return result;
  }

  /**
   * Execute test suite using LangGraph
   * Each test step runs as a separate graph invocation, resetting recursion counter
   * @param testFilePath - Path to test file
   * @param browserNum - Which browser to run on (1 or 2)
   * @param startingUrl - URL to navigate to, or null to use current page
   */
  async runTestSuite(testFilePath: string, browserNum: 1 | 2 = 1, startingUrl: string | null = null) {
    const testSteps = this.parseTestFile(testFilePath);

    console.log(`\n🧪 Running test suite with LangGraph on Browser ${browserNum}`);

    try {
      // Initialize MCP clients and optionally navigate to starting URL
      if (startingUrl) {
        console.log(`📍 Starting URL: ${startingUrl}\n`);
        await this.initializeBrowser(browserNum, startingUrl);
      } else {
        console.log(`📍 Using current page on Browser ${browserNum}\n`);
        await this.initializeMCP();
      }

      // Build the step workflow once
      const stepApp = this.buildStepWorkflow();

      // Track state across steps
      let currentState: TestState = {
        testSteps,
        currentStepIndex: 0,
        results: [],
        executionHistory: [],
        shouldContinue: true,
        startingUrl: startingUrl || undefined,
        sessionId: 'mcp-session',
        browserNum,
      };

      // Run each test step as a separate graph invocation
      // This resets the recursion counter for each step
      for (let i = 0; i < testSteps.length; i++) {
        currentState.currentStepIndex = i;
        // Set browserNum from the current step (supports *1/*2 prefix switching)
        currentState.browserNum = testSteps[i].browserNum;

        const stepBrowser = testSteps[i].browserNum;
        if (stepBrowser !== browserNum) {
          console.log(`🔄 Switching to Browser ${stepBrowser}`);
        }

        // Invoke graph for this single step (recursion limit is per-invocation)
        const stepResult = await stepApp.invoke(currentState as any, {
          recursionLimit: 25, // Reasonable limit per step to catch infinite loops
        });

        // Update state with results from this step
        currentState = stepResult as unknown as TestState;

        // Stop if step failed
        if (!currentState.shouldContinue) {
          break;
        }
      }

      // Print summary
      const passed = currentState.results.filter(r => r.success).length;
      const failed = currentState.results.filter(r => !r.success).length;

      console.log(`\n${'='.repeat(60)}`);
      console.log(`📊 Test Summary:`);
      console.log(`   ✅ Passed: ${passed}`);
      console.log(`   ❌ Failed: ${failed}`);
      console.log(`   📈 Total: ${testSteps.length}`);
      console.log(`${'='.repeat(60)}\n`);

      return currentState;
    } finally {
      // Clean up MCP connection
      await this.closeMCP();
    }
  }

  /**
   * Read page content via MCP using browser_snapshot
   */
  private async readPage(_sessionId: string, browserNum: 1 | 2): Promise<string> {
    const mcpClient = this.getMcpClient(browserNum);

    try {
      const result = await mcpClient.callTool({
        name: 'browser_snapshot',
        arguments: {}
      });

      // Return the content from the tool result
      if (result.content && Array.isArray(result.content)) {
        const textContent = result.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
        return textContent;
      }

      return JSON.stringify(result.content || result);
    } catch (error) {
      console.error('Error reading page:', error);
      throw error;
    }
  }

  /**
   * Parse special commands (go to, reset session, scroll)
   */
  private parseSpecialCommand(instruction: string): { type: 'navigate' | 'reset' | 'scroll' | 'none'; url?: string; direction?: 'down' | 'up' } {
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

  /**
   * Execute a special command directly via MCP (no AI involved)
   */
  private async executeSpecialCommand(
    cmd: { type: 'navigate' | 'reset' | 'scroll' | 'none'; url?: string; direction?: 'down' | 'up' },
    browserNum: 1 | 2
  ): Promise<string> {
    const mcpClient = this.getMcpClient(browserNum);

    if (cmd.type === 'navigate' && cmd.url) {
      console.log(`   🔗 Navigating to ${cmd.url}...`);
      await mcpClient.callTool({
        name: 'browser_navigate',
        arguments: { url: cmd.url }
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
      return `Navigated to ${cmd.url}`;

    } else if (cmd.type === 'reset') {
      console.log(`   🔄 Clearing session/storage...`);
      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: '() => { localStorage.clear(); sessionStorage.clear(); }' }
      });
      console.log(`   🔄 Reloading page...`);
      // Use browser_evaluate to reload the page
      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: '() => { location.reload(); }' }
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
      return 'Session/storage cleared and page reloaded';

    } else if (cmd.type === 'scroll') {
      const direction = cmd.direction || 'down';
      console.log(`   📜 Scrolling ${direction}...`);
      const scrollCode = direction === 'down'
        ? '() => { window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" }); }'
        : '() => { window.scrollBy({ top: -window.innerHeight * 0.8, behavior: "smooth" }); }';
      await mcpClient.callTool({
        name: 'browser_evaluate',
        arguments: { function: scrollCode }
      });
      await new Promise(resolve => setTimeout(resolve, 500));
      return `Scrolled ${direction}`;
    }

    return 'Unknown command';
  }

  /**
   * Execute actions for a test step using AI
   */
  private async executeStepActions(
    step: { instruction: string; expectedResult: string },
    pageContent: string,
    executionHistory: string[],
    browserNum: 1 | 2
  ): Promise<{
    executedActions: string[];
  }> {
    // Check for special commands first - execute directly without AI
    const specialCmd = this.parseSpecialCommand(step.instruction);
    if (specialCmd.type !== 'none') {
      const result = await this.executeSpecialCommand(specialCmd, browserNum);
      return { executedActions: [result] };
    }

    const prompt = `You are a QA automation agent executing web UI tests.

CURRENT PAGE STATE:
${pageContent}

EXECUTION HISTORY:
${executionHistory.join('\n') || '(none yet)'}

TEST INSTRUCTION:
${step.instruction}

AVAILABLE TOOLS:
You can use the following actions:
- { type: 'click', element: 'description', ref: 'element-ref' } - Click on an element (element is human-readable description, ref is from page snapshot)
- { type: 'fill', element: 'description', ref: 'element-ref', value: 'text' } - Fill a form field
- { type: 'fill', element: 'description', ref: 'element-ref', memoryKey: 'key-name' } - Fill a form field with a value from memory
- { type: 'navigate', url: 'https://...' } - Navigate to a URL
- { type: 'memory_store', key: 'variable-name', value: 'any-value' } - Store a value in memory for later use

CURRENT MEMORY STATE:
${JSON.stringify(Object.fromEntries(this.memory))}

YOUR TASK:
Analyze the page state and determine the actions needed to execute the instruction.
Use memory_store to save information you need to remember (like user credentials, IDs, etc.)
When you need to fill a field with a value from memory, use the 'memoryKey' property instead of 'value'.
Return a JSON response with:
- actions: Array of action objects

IMPORTANT:
- For click and fill actions, provide both 'element' (human-readable description) and 'ref' (exact reference from snapshot)
- When filling a field with a stored memory value, use { type: 'fill', element: 'description', ref: 'element-ref', memoryKey: 'stored-key' }

Format your response as valid JSON.`;

    try {
      const response = await this.model.invoke([new HumanMessage(prompt)]);
      const content = typeof response.content === 'string' ? response.content : '';

      // Parse AI's response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { executedActions: [] };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const actions: string[] = [];

      // Execute actions via MCP
      for (const action of parsed.actions || []) {
        const actionStr = await this.executeMCPAction(action, browserNum);
        actions.push(actionStr);
      }

      return { executedActions: actions };
    } catch (error) {
      console.error('Error executing actions:', error);
      return { executedActions: [] };
    }
  }

  /**
   * Verify that the expected result is present in the page
   */
  private async verifyExpectedResult(
    expectedResult: string,
    pageContent: string
  ): Promise<{
    success: boolean;
    actualResult: string;
  }> {
    const prompt = `You are a QA automation agent verifying test results.

CURRENT PAGE STATE:
${pageContent}

CURRENT MEMORY STATE:
${JSON.stringify(Object.fromEntries(this.memory))}

EXPECTED RESULT:
${expectedResult}

AVAILABLE VERIFICATION TOOLS:
You can use tools to help verify the expected result:
- { type: 'memory_read', key: 'variable-name' } - Read a value from memory to verify it exists or has a specific value

YOUR TASK:
Analyze the current page state AND memory state to determine if the expected result is met.
You can verify:
1. Page content (text, elements visible on the page)
2. Memory values (check if specific values are stored in memory)

Return a JSON response with:
- success: Boolean - true if the expected result is found, false otherwise
- actualResult: String - a brief description of what you found (either confirming the expected result or explaining what's different)
- memoryChecks: (optional) Array of { key: string, expectedValue?: any } - memory keys you checked

Be precise and check the actual page content and memory state, not assumptions.

Format your response as valid JSON.`;

    try {
      const response = await this.model.invoke([new HumanMessage(prompt)]);
      const content = typeof response.content === 'string' ? response.content : '';

      // Parse AI's response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          success: false,
          actualResult: 'Could not parse verification response',
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        success: parsed.success ?? false,
        actualResult: parsed.actualResult || 'Verification completed',
      };
    } catch (error) {
      return {
        success: false,
        actualResult: `Verification error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Execute an MCP action or memory operation
   */
  private async executeMCPAction(action: any, browserNum: 1 | 2): Promise<string> {
    const { type, element, ref, value, url, key, memoryKey } = action;

    // Handle memory operations first
    if (type === 'memory_store') {
      return this.storeInMemory(key, value);
    }

    if (type === 'memory_read') {
      const memoryValue = this.readFromMemory(key);
      return `Read ${key} from memory: ${JSON.stringify(memoryValue)}`;
    }

    // Handle MCP actions
    const mcpClient = this.getMcpClient(browserNum);

    let toolName = '';
    let args: any = {};

    switch (type) {
      case 'click':
        toolName = 'browser_click';
        // browser_click requires both element (description) and ref
        args = { element: element || ref, ref };
        break;
      case 'fill':
        toolName = 'browser_type';
        // If memoryKey is provided, read the value from memory
        let fillValue = value;
        if (memoryKey) {
          fillValue = this.readFromMemory(memoryKey);
          if (fillValue === undefined) {
            console.warn(`   ⚠️ Memory key "${memoryKey}" not found, using empty string`);
            fillValue = '';
          }
        }
        // browser_type requires element, ref, and text
        args = { element: element || ref, ref, text: fillValue };
        break;
      case 'navigate':
        toolName = 'browser_navigate';
        args = { url };
        break;
      default:
        return `Unknown action type: ${type}`;
    }

    try {
      console.log(`   🔧 ${toolName}:`, args);
      await mcpClient.callTool({
        name: toolName,
        arguments: args
      });

      return `${toolName}(${JSON.stringify(args)})`;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`   ❌ ${toolName} failed:`, errorMsg);
      return `${toolName} error: ${errorMsg}`;
    }
  }
}
