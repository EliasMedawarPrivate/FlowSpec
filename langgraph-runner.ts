import { StateGraph, END, START } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Persistent memory file path
const MEMORY_FILE_PATH = './.memory-state.json';

// Plans directory
const PLANS_DIR = './plans';

// ===== Execution Plan Types =====

export interface PlanAction {
  type: 'click' | 'fill' | 'navigate' | 'memory_store' | 'memory_read';
  element?: string;
  ref?: string;
  textContent?: string;
  role?: string;
  value?: string;
  memoryKey?: string;
  url?: string;
  key?: string;
  extractionHint?: string;
  extractionRegex?: string;
}

export interface PlanStep {
  originalInstruction: string;
  type: 'action' | 'special';
  actions: PlanAction[];
  specialCommand?: { type: string; url?: string; direction?: string };
  verification: {
    match: string[];
    notMatch: string[];
    memoryChecks: Array<{ key: string; pattern?: string; shouldExist?: boolean }>;
  } | null;
  delay: number;
  browserNum: 1 | 2;
  learnedAt: string | null;
  failCount: number;
}

export interface ExecutionPlan {
  scenarioName: string;
  createdAt: string;
  updatedAt: string;
  steps: PlanStep[];
}

// ===== Plan File I/O =====

export function loadPlan(scenarioName: string): ExecutionPlan | null {
  try {
    const planPath = path.join(PLANS_DIR, scenarioName.replace('.txt', '.plan.json'));
    if (fs.existsSync(planPath)) {
      const content = fs.readFileSync(planPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {
    console.warn('⚠️ Could not load plan file:', e);
  }
  return null;
}

export function savePlan(plan: ExecutionPlan): void {
  try {
    if (!fs.existsSync(PLANS_DIR)) {
      fs.mkdirSync(PLANS_DIR, { recursive: true });
    }
    const planPath = path.join(PLANS_DIR, plan.scenarioName.replace('.txt', '.plan.json'));
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
  } catch (e) {
    console.warn('⚠️ Could not save plan file:', e);
  }
}

export function findPlanStep(plan: ExecutionPlan | null, instruction: string): PlanStep | null {
  if (!plan) return null;
  return plan.steps.find(s => s.originalInstruction === instruction) || null;
}

export function upsertPlanStep(plan: ExecutionPlan, step: PlanStep): void {
  const idx = plan.steps.findIndex(s => s.originalInstruction === step.originalInstruction);
  if (idx >= 0) {
    plan.steps[idx] = step;
  } else {
    plan.steps.push(step);
  }
  plan.updatedAt = new Date().toISOString();
}

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
  private maxRetries: number;

  constructor(
    apiKey?: string,
    model: string = "qwen/qwen3-30b-a3b-thinking-2507",
    maxRetries: number = 2
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
    this.maxRetries = maxRetries;
    console.log(`📦 Loaded ${this.memory.size} items from persistent memory`);
    console.log(`🔄 Max retries per step: ${this.maxRetries}`);
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
   * File inclusion: ##FileName.txt - includes all lines from the referenced file
   */
  parseTestFile(filePath: string): Array<{ instruction: string; expectedResult: string; delay: number; browserNum: 1 | 2 }> {
    const baseDir = path.dirname(filePath);
    return this.parseTestFileContent(filePath, baseDir, new Set<string>());
  }

  /**
   * Internal method to parse test file content with include support
   * @param filePath - Path to the test file
   * @param baseDir - Base directory for resolving relative includes
   * @param includedFiles - Set of already included files to prevent circular includes
   */
  private parseTestFileContent(
    filePath: string,
    baseDir: string,
    includedFiles: Set<string>
  ): Array<{ instruction: string; expectedResult: string; delay: number; browserNum: 1 | 2 }> {
    const absolutePath = path.resolve(filePath);

    // Check for circular includes
    if (includedFiles.has(absolutePath)) {
      console.warn(`⚠️ Circular include detected, skipping: ${filePath}`);
      return [];
    }
    includedFiles.add(absolutePath);

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const steps: Array<{ instruction: string; expectedResult: string; delay: number; browserNum: 1 | 2 }> = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue; // Skip empty lines

      // Check for file inclusion syntax: ##FileName.txt
      const includeMatch = trimmed.match(/^##(.+\.txt)$/i);
      if (includeMatch) {
        const includeFileName = includeMatch[1];
        const includePath = path.resolve(baseDir, includeFileName);

        console.log(`📂 Including file: ${includeFileName}`);

        try {
          // Recursively parse the included file
          const includedSteps = this.parseTestFileContent(includePath, path.dirname(includePath), includedFiles);
          steps.push(...includedSteps);
          console.log(`   ✅ Included ${includedSteps.length} steps from ${includeFileName}`);
        } catch (error) {
          console.error(`   ❌ Failed to include ${includeFileName}:`, error instanceof Error ? error.message : error);
        }
        continue;
      }

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
   * Run a single step with retry logic
   * Retries the step up to maxRetries times if it fails
   * @param stepApp - Compiled step workflow
   * @param state - Current test state
   * @param stepIndex - Index of the step being run (for logging)
   * @returns Updated state after step execution (with retries if needed)
   */
  private async runStepWithRetry(
    stepApp: ReturnType<typeof this.buildStepWorkflow>,
    state: TestState,
    stepIndex: number
  ): Promise<TestState> {
    let attempt = 0;
    let lastState = state;

    while (attempt <= this.maxRetries) {
      if (attempt > 0) {
        console.log(`\n🔄 Retry attempt ${attempt}/${this.maxRetries} for step ${stepIndex + 1}...`);
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Reset results for this step on retry (keep previous steps' results)
      const stateForAttempt: TestState = {
        ...lastState,
        results: lastState.results.filter(r => r.stepIndex !== stepIndex),
      };

      const stepResult = await stepApp.invoke(stateForAttempt as any, {
        recursionLimit: 25,
      });

      lastState = stepResult as unknown as TestState;

      // Check if this step succeeded
      const stepResults = lastState.results.filter(r => r.stepIndex === stepIndex);
      const stepSucceeded = stepResults.length > 0 && stepResults[stepResults.length - 1].success;

      if (stepSucceeded) {
        if (attempt > 0) {
          console.log(`   ✅ Step ${stepIndex + 1} succeeded on retry ${attempt}`);
        }
        return lastState;
      }

      attempt++;
    }

    // All retries exhausted
    console.log(`   ❌ Step ${stepIndex + 1} failed after ${this.maxRetries} retries`);
    return lastState;
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

    // Run with retry logic
    const finalState = await this.runStepWithRetry(stepApp, initialState, 0);

    const result = finalState.results[0] || {
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

        // Run step with retry logic
        currentState = await this.runStepWithRetry(
          stepApp,
          currentState,
          i
        );

        // Stop if step failed (after all retries exhausted)
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
    rawActions?: any[];
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
      const rawActions = parsed.actions || [];

      // Execute actions via MCP
      for (const action of rawActions) {
        const actionStr = await this.executeMCPAction(action, browserNum);
        actions.push(actionStr);
      }

      return { executedActions: actions, rawActions };
    } catch (error) {
      console.error('Error executing actions:', error);
      return { executedActions: [] };
    }
  }

  /**
   * Get regex patterns from LLM for verifying expected result
   * The LLM analyzes the expected result and returns regex patterns to check locally
   * Supports both "match" (must be present) and "notMatch" (must NOT be present) patterns
   */
  private async getVerificationPatterns(
    expectedResult: string
  ): Promise<{
    match: string[];
    notMatch: string[];
    memoryChecks: Array<{ key: string; pattern?: string; shouldExist?: boolean }>;
  }> {
    const prompt = `You are a QA automation agent. Given an expected result description, provide regex patterns to verify it.

EXPECTED RESULT:
${expectedResult}

CURRENT MEMORY STATE (for reference):
${JSON.stringify(Object.fromEntries(this.memory))}

YOUR TASK:
Provide regex patterns to verify the expected result. Patterns are tested against the page's text content (case-insensitive).

Return a JSON response with:
- match: Array of regex patterns that SHOULD be found (at least one must match for success)
  - Examples: "welcome.*dashboard", "login.*successful", "order.*confirmed"
- notMatch: Array of regex patterns that should NOT be found (if any matches, verification fails)
  - Use this for verifying something disappeared or is absent
  - Examples: "error", "invalid.*password", "login.*form", "please.*try.*again"
- memoryChecks: (optional) Array of { key: string, pattern?: string, shouldExist?: boolean }
  - shouldExist: true (default) = key must exist, false = key must NOT exist

EXAMPLES:
1. Expected: "user is logged in" → { "match": ["welcome", "dashboard", "logout"], "notMatch": ["login.*form", "sign.*in"] }
2. Expected: "error message disappeared" → { "match": [], "notMatch": ["error", "invalid", "failed"] }
3. Expected: "form submitted successfully" → { "match": ["success", "thank.*you", "submitted"], "notMatch": ["error", "required.*field"] }

IMPORTANT:
- Use simple, flexible patterns
- For "notMatch", think about what should NOT appear if the expected result is true
- Empty arrays are valid (e.g., match: [] with notMatch patterns only)

Format your response as valid JSON only.`;

    try {
      const response = await this.model.invoke([new HumanMessage(prompt)]);
      const content = typeof response.content === 'string' ? response.content : '';

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        // Fallback: use the expected result as a simple match pattern
        return {
          match: [expectedResult.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')],
          notMatch: [],
          memoryChecks: [],
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        match: parsed.match || parsed.patterns || [expectedResult],
        notMatch: parsed.notMatch || [],
        memoryChecks: parsed.memoryChecks || [],
      };
    } catch (error) {
      console.error('Error getting verification patterns:', error);
      // Fallback: escape the expected result and use as literal match pattern
      return {
        match: [expectedResult.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')],
        notMatch: [],
        memoryChecks: [],
      };
    }
  }

  /**
   * Verify that the expected result is present in the page using local regex matching
   * LLM provides patterns, verification is done locally
   * Supports both "match" (must be present) and "notMatch" (must NOT be present) patterns
   */
  private async verifyExpectedResult(
    expectedResult: string,
    pageContent: string
  ): Promise<{
    success: boolean;
    actualResult: string;
  }> {
    // Get regex patterns from LLM
    console.log('   🔍 Getting verification patterns from LLM...');
    const { match, notMatch, memoryChecks } = await this.getVerificationPatterns(expectedResult);

    if (match.length > 0) {
      console.log(`   📋 Must match (any): ${match.map((p: string) => `"${p}"`).join(', ')}`);
    }
    if (notMatch.length > 0) {
      console.log(`   🚫 Must NOT match: ${notMatch.map((p: string) => `"${p}"`).join(', ')}`);
    }

    // Check memory conditions first
    for (const check of memoryChecks) {
      const memValue = this.memory.get(check.key);
      const shouldExist = check.shouldExist !== false; // default true

      if (shouldExist && memValue === undefined) {
        return {
          success: false,
          actualResult: `Memory key "${check.key}" not found`,
        };
      }
      if (!shouldExist && memValue !== undefined) {
        return {
          success: false,
          actualResult: `Memory key "${check.key}" should not exist but has value "${memValue}"`,
        };
      }
      if (shouldExist && check.pattern) {
        try {
          const regex = new RegExp(check.pattern, 'i');
          if (!regex.test(String(memValue))) {
            return {
              success: false,
              actualResult: `Memory "${check.key}" value "${memValue}" doesn't match pattern "${check.pattern}"`,
            };
          }
        } catch (e) {
          console.warn(`   ⚠️ Invalid memory check pattern: ${check.pattern}`);
        }
      }
    }

    // Check notMatch patterns first - if any matches, fail immediately
    for (const pattern of notMatch) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(pageContent)) {
          return {
            success: false,
            actualResult: `Found forbidden pattern: "${pattern}"`,
          };
        }
      } catch (e) {
        console.warn(`   ⚠️ Invalid notMatch regex pattern: ${pattern}`);
      }
    }

    // If there are no match patterns, and all notMatch patterns passed, success
    if (match.length === 0) {
      return {
        success: true,
        actualResult: `No forbidden patterns found`,
      };
    }

    // Check match patterns - at least one must match
    for (const pattern of match) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(pageContent)) {
          return {
            success: true,
            actualResult: `Matched pattern: "${pattern}"`,
          };
        }
      } catch (e) {
        console.warn(`   ⚠️ Invalid match regex pattern: ${pattern}`);
      }
    }

    // No match patterns matched
    return {
      success: false,
      actualResult: `No patterns matched. Tried: ${match.map((p: string) => `"${p}"`).join(', ')}`,
    };
  }

  // ===== Learning Mode Methods =====

  /**
   * Enrich raw LLM actions with textContent/role from page snapshot for plan storage.
   * This makes the plan resilient to ref changes between runs.
   */
  private enrichActionsForPlan(rawActions: any[], pageContent: string): PlanAction[] {
    return rawActions.map(action => {
      const planAction: PlanAction = {
        type: action.type,
        element: action.element,
        ref: action.ref,
        value: action.value,
        memoryKey: action.memoryKey,
        url: action.url,
        key: action.key,
      };

      // Extract textContent and role from page snapshot for click/fill actions
      if (action.ref && (action.type === 'click' || action.type === 'fill')) {
        const escapedRef = action.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Try to extract role from nearby context
        const rolePattern = new RegExp(`(button|link|textbox|checkbox|radio|combobox|heading|img|tab|menu)[^\\n]*\\[ref=${escapedRef}\\]`, 'i');
        const roleMatch = pageContent.match(rolePattern);
        if (roleMatch) {
          planAction.role = roleMatch[1].toLowerCase();
        }

        // For textContent: use the LLM-provided element description (most reliable)
        // The page snapshot format varies too much to regex-extract clean text
        planAction.textContent = action.element || action.ref;
      }

      // For memory_store with dynamic values from the page, store extraction hints
      // Don't store the literal value or regex — values are dynamic and change every run
      if (action.type === 'memory_store' && action.value) {
        planAction.extractionHint = action.element || `Extract the value labeled "${action.key}" from the page`;
        delete planAction.value;
      }

      return planAction;
    });
  }

  /**
   * Run a single step in learning mode: execute with LLM and capture plan data.
   * Returns both the test result and the captured PlanStep.
   */
  async runSingleStepLearning(
    instruction: string,
    browserNum: 1 | 2 = 1
  ): Promise<{ result: TestResult; planStep: PlanStep }> {
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

    console.log(`\n📚 Learning step on Browser ${browserNum}: ${step.instruction}`);

    // Check for special commands
    const specialCmd = this.parseSpecialCommand(step.instruction);
    if (specialCmd.type !== 'none') {
      const actionResult = await this.executeSpecialCommand(specialCmd, browserNum);
      const result: TestResult = {
        stepIndex: 0,
        instruction: step.instruction,
        expectedResult: '(auto-pass)',
        actualResult: 'Command executed successfully',
        success: true,
        executedActions: [actionResult],
        timestamp: new Date(),
      };
      const planStep: PlanStep = {
        originalInstruction: trimmed,
        type: 'special',
        actions: [],
        specialCommand: specialCmd,
        verification: null,
        delay: step.delay,
        browserNum,
        learnedAt: new Date().toISOString(),
        failCount: 0,
      };
      return { result, planStep };
    }

    // Step 1: Read page
    console.log('📖 Reading page content...');
    const pageContent = await this.readPage('mcp-session', browserNum);

    // Step 2: Execute with LLM (captures raw actions)
    const { executedActions, rawActions } = await this.executeStepActions(
      step, pageContent, [], browserNum
    );

    // Step 3: Enrich actions for plan
    const planActions = this.enrichActionsForPlan(rawActions || [], pageContent);

    // Step 4: Verify
    let verification: { match: string[]; notMatch: string[]; memoryChecks: any[] } | null = null;
    let verifyResult = { success: true, actualResult: 'Command executed successfully' };

    if (step.expectedResult !== '__AUTO_PASS__') {
      await new Promise(resolve => setTimeout(resolve, step.delay));
      console.log('   📖 Reading page after actions...');
      const newPageContent = await this.readPage('mcp-session', browserNum);

      // Get verification patterns from LLM (and capture them for the plan)
      console.log('   🔍 Getting verification patterns from LLM...');
      verification = await this.getVerificationPatterns(step.expectedResult);

      // Verify locally
      verifyResult = await this.verifyWithPatterns(verification, newPageContent);
      const statusIcon = verifyResult.success ? '✅' : '❌';
      console.log(`   ${statusIcon} ${verifyResult.actualResult}`);
    } else {
      await new Promise(resolve => setTimeout(resolve, Math.max(step.delay, 200)));
    }

    const result: TestResult = {
      stepIndex: 0,
      instruction: step.instruction,
      expectedResult: step.expectedResult === '__AUTO_PASS__' ? '(auto-pass)' : step.expectedResult,
      actualResult: verifyResult.actualResult,
      success: verifyResult.success,
      executedActions,
      timestamp: new Date(),
    };

    const planStep: PlanStep = {
      originalInstruction: trimmed,
      type: 'action',
      actions: planActions,
      verification,
      delay: step.delay,
      browserNum,
      learnedAt: new Date().toISOString(),
      failCount: 0,
    };

    console.log(`   📋 Learned: ${planActions.length} actions, verification: ${verification ? 'yes' : 'none'}`);

    return { result, planStep };
  }

  // ===== Plan Replay Methods =====

  /**
   * Resolve element ref by matching textContent against current page snapshot.
   * Returns the current ref or null if not found.
   */
  private resolveElementRef(action: PlanAction, pageContent: string): string | null {
    if (!action.textContent) return action.ref || null;

    const escapedText = action.textContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Strategy 1: role + text on same line (most precise)
    // Matches: `button "Plus tard" [ref=e24]` or `link "Espace Maître du Jeu" [ref=e122]`
    if (action.role) {
      const roleBeforeRef = new RegExp(`${action.role}[^\\n]*${escapedText}[^\\n]*\\[ref=(\\w+)\\]`, 'i');
      const m1 = pageContent.match(roleBeforeRef);
      if (m1) return m1[1];

      const roleAfterRef = new RegExp(`${action.role}[^\\n]*\\[ref=(\\w+)\\][^\\n]*${escapedText}`, 'i');
      const m2 = pageContent.match(roleAfterRef);
      if (m2) return m2[1];
    }

    // Strategy 2: text before ref on same line (Playwright format: `"Plus tard" [ref=e24]`)
    const textBeforeRef = new RegExp(`${escapedText}[^\\n]*\\[ref=(\\w+)\\]`, 'i');
    const m3 = pageContent.match(textBeforeRef);
    if (m3) return m3[1];

    // Strategy 3: text after ref on same line (`[ref=e24] Plus tard`)
    const textAfterRef = new RegExp(`\\[ref=(\\w+)\\][^\\n]*${escapedText}`, 'i');
    const m4 = pageContent.match(textAfterRef);
    if (m4) return m4[1];

    // Strategy 4: Try with element description if different from textContent
    if (action.element && action.element !== action.textContent) {
      const escapedElem = action.element.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const elemBeforeRef = new RegExp(`${escapedElem}[^\\n]*\\[ref=(\\w+)\\]`, 'i');
      const m5 = pageContent.match(elemBeforeRef);
      if (m5) return m5[1];

      const elemAfterRef = new RegExp(`\\[ref=(\\w+)\\][^\\n]*${escapedElem}`, 'i');
      const m6 = pageContent.match(elemAfterRef);
      if (m6) return m6[1];
    }

    return null;
  }

  /**
   * Verify using stored plan patterns (no LLM call).
   * Reuses the same regex logic as verifyExpectedResult.
   */
  private async verifyWithPatterns(
    verification: { match: string[]; notMatch: string[]; memoryChecks: Array<{ key: string; pattern?: string; shouldExist?: boolean }> },
    pageContent: string
  ): Promise<{ success: boolean; actualResult: string }> {
    const { match, notMatch, memoryChecks } = verification;

    if (match.length > 0) {
      console.log(`   📋 Must match (any): ${match.map((p: string) => `"${p}"`).join(', ')}`);
    }
    if (notMatch.length > 0) {
      console.log(`   🚫 Must NOT match: ${notMatch.map((p: string) => `"${p}"`).join(', ')}`);
    }

    // Check memory conditions
    for (const check of memoryChecks) {
      const memValue = this.memory.get(check.key);
      const shouldExist = check.shouldExist !== false;
      if (shouldExist && memValue === undefined) {
        return { success: false, actualResult: `Memory key "${check.key}" not found` };
      }
      if (!shouldExist && memValue !== undefined) {
        return { success: false, actualResult: `Memory key "${check.key}" should not exist but has value "${memValue}"` };
      }
      if (shouldExist && check.pattern) {
        try {
          const regex = new RegExp(check.pattern, 'i');
          if (!regex.test(String(memValue))) {
            return { success: false, actualResult: `Memory "${check.key}" value "${memValue}" doesn't match pattern "${check.pattern}"` };
          }
        } catch (e) { /* skip invalid pattern */ }
      }
    }

    // Check notMatch patterns
    for (const pattern of notMatch) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(pageContent)) {
          return { success: false, actualResult: `Found forbidden pattern: "${pattern}"` };
        }
      } catch (e) { /* skip invalid pattern */ }
    }

    // If no match patterns, and notMatch all passed
    if (match.length === 0) {
      return { success: true, actualResult: 'No forbidden patterns found' };
    }

    // Check match patterns
    for (const pattern of match) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(pageContent)) {
          return { success: true, actualResult: `Matched pattern: "${pattern}"` };
        }
      } catch (e) { /* skip invalid pattern */ }
    }

    return { success: false, actualResult: `No patterns matched. Tried: ${match.map((p: string) => `"${p}"`).join(', ')}` };
  }

  /**
   * Extract a dynamic value from the page using regex first, LLM fallback.
   */
  private async extractDynamicValue(
    extractionRegex: string | undefined,
    extractionHint: string | undefined,
    pageContent: string,
    browserNum: 1 | 2
  ): Promise<string | null> {
    // Strategy 1: Try regex extraction
    if (extractionRegex) {
      try {
        const regex = new RegExp(extractionRegex, 'i');
        const match = pageContent.match(regex);
        if (match) {
          return match[0];
        }
      } catch (e) { /* invalid regex, fall through */ }
    }

    // Strategy 2: Small focused LLM call
    if (extractionHint) {
      try {
        const prompt = `Extract the following value from this page content. Return ONLY the value, nothing else.

VALUE TO EXTRACT: ${extractionHint}

PAGE CONTENT:
${pageContent.substring(0, 4000)}

Return only the extracted value as plain text.`;

        const response = await this.model.invoke([new HumanMessage(prompt)]);
        const content = typeof response.content === 'string' ? response.content.trim() : '';
        if (content) return content;
      } catch (e) {
        console.warn('   ⚠️ LLM extraction failed:', e);
      }
    }

    return null;
  }

  /**
   * Replay a learned plan step without LLM calls (except for dynamic value extraction).
   */
  async replayPlanStep(
    planStep: PlanStep,
    browserNum: 1 | 2
  ): Promise<{ success: boolean; result: TestResult }> {
    console.log(`\n⚡ Replaying plan step on Browser ${browserNum}: ${planStep.originalInstruction.substring(0, 60)}...`);

    // Handle special commands directly
    if (planStep.type === 'special' && planStep.specialCommand) {
      const cmd = planStep.specialCommand as { type: 'navigate' | 'reset' | 'scroll' | 'none'; url?: string; direction?: 'down' | 'up' };
      const actionResult = await this.executeSpecialCommand(cmd, browserNum);
      return {
        success: true,
        result: {
          stepIndex: 0,
          instruction: planStep.originalInstruction,
          expectedResult: '(auto-pass)',
          actualResult: 'Command executed successfully',
          success: true,
          executedActions: [actionResult],
          timestamp: new Date(),
        },
      };
    }

    // Step 1: Read current page
    console.log('   📖 Reading page content...');
    const pageContent = await this.readPage('mcp-session', browserNum);
    const executedActions: string[] = [];

    // Step 2: Execute each recorded action
    for (const action of planStep.actions) {
      // Handle dynamic memory_store
      if (action.type === 'memory_store' && (action.extractionHint || action.extractionRegex)) {
        const value = await this.extractDynamicValue(
          action.extractionRegex, action.extractionHint, pageContent, browserNum
        );
        if (value && action.key) {
          this.storeInMemory(action.key, value);
          executedActions.push(`memory_store: ${action.key} = ${value}`);
        } else {
          console.warn(`   ⚠️ Could not extract dynamic value for ${action.key}`);
          return {
            success: false,
            result: {
              stepIndex: 0,
              instruction: planStep.originalInstruction,
              expectedResult: '',
              actualResult: `Failed to extract dynamic value for ${action.key}`,
              success: false,
              executedActions,
              timestamp: new Date(),
            },
          };
        }
        continue;
      }

      // Handle static memory_store
      if (action.type === 'memory_store' && action.key && action.value) {
        this.storeInMemory(action.key, action.value);
        executedActions.push(`memory_store: ${action.key} = ${action.value}`);
        continue;
      }

      if (action.type === 'memory_read' && action.key) {
        this.readFromMemory(action.key);
        executedActions.push(`memory_read: ${action.key}`);
        continue;
      }

      // Resolve current ref for click/fill actions
      let actionToExecute: any = { ...action };
      if ((action.type === 'click' || action.type === 'fill') && action.textContent) {
        const resolvedRef = this.resolveElementRef(action, pageContent);
        if (resolvedRef) {
          console.log(`   🔗 Resolved ref: ${action.ref} → ${resolvedRef} (via "${action.textContent}")`);
          actionToExecute.ref = resolvedRef;
        } else {
          console.warn(`   ⚠️ Could not resolve element: "${action.textContent}"`);
          return {
            success: false,
            result: {
              stepIndex: 0,
              instruction: planStep.originalInstruction,
              expectedResult: '',
              actualResult: `Could not find element: "${action.textContent}"`,
              success: false,
              executedActions,
              timestamp: new Date(),
            },
          };
        }
      }

      // Execute the MCP action
      const actionStr = await this.executeMCPAction(actionToExecute, browserNum);
      executedActions.push(actionStr);

      if (actionStr.includes('error')) {
        return {
          success: false,
          result: {
            stepIndex: 0,
            instruction: planStep.originalInstruction,
            expectedResult: '',
            actualResult: actionStr,
            success: false,
            executedActions,
            timestamp: new Date(),
          },
        };
      }
    }

    // Step 3: Verify with stored patterns
    if (planStep.verification) {
      await new Promise(resolve => setTimeout(resolve, planStep.delay));
      console.log('   📖 Reading page after actions...');
      const newPageContent = await this.readPage('mcp-session', browserNum);

      const verifyResult = await this.verifyWithPatterns(planStep.verification, newPageContent);
      const statusIcon = verifyResult.success ? '✅' : '❌';
      console.log(`   ${statusIcon} ${verifyResult.actualResult}`);

      // Parse expected result from original instruction
      let expectedResult = '(auto-pass)';
      if (planStep.originalInstruction.includes('>>>')) {
        expectedResult = planStep.originalInstruction.split('>>>')[1]?.trim() || '(auto-pass)';
      }

      return {
        success: verifyResult.success,
        result: {
          stepIndex: 0,
          instruction: planStep.originalInstruction,
          expectedResult,
          actualResult: verifyResult.actualResult,
          success: verifyResult.success,
          executedActions,
          timestamp: new Date(),
        },
      };
    }

    // No verification needed (auto-pass)
    await new Promise(resolve => setTimeout(resolve, Math.max(planStep.delay, 200)));
    return {
      success: true,
      result: {
        stepIndex: 0,
        instruction: planStep.originalInstruction,
        expectedResult: '(auto-pass)',
        actualResult: 'Command executed successfully',
        success: true,
        executedActions,
        timestamp: new Date(),
      },
    };
  }

  /**
   * Run a single step with plan support.
   * - learningMode=true: run with LLM, capture plan data
   * - learningMode=false + planStep: replay plan, fallback to LLM on failure
   * - learningMode=false + no planStep: run with LLM (normal mode)
   */
  async runSingleStepWithPlan(
    instruction: string,
    browserNum: 1 | 2,
    plan: ExecutionPlan | null,
    learningMode: boolean,
    planMatchKey?: string
  ): Promise<{ result: TestResult; updatedPlanStep?: PlanStep; planUpdated?: boolean }> {
    const matchKey = planMatchKey || instruction.trim();
    const planStep = findPlanStep(plan, matchKey);

    if (learningMode) {
      // Learning mode: run with LLM and capture plan data
      const { result, planStep: newPlanStep } = await this.runSingleStepLearning(instruction, browserNum);
      return { result, updatedPlanStep: newPlanStep, planUpdated: true };
    }

    if (planStep && planStep.learnedAt) {
      // Plan execution mode: replay
      console.log('   ⚡ Using learned plan (no LLM)');
      const replayResult = await this.replayPlanStep(planStep, browserNum);

      if (replayResult.success) {
        return { result: replayResult.result };
      }

      // Fallback: plan failed, re-learn with LLM
      console.log('   🔄 Plan replay failed, falling back to LLM...');
      const { result, planStep: newPlanStep } = await this.runSingleStepLearning(instruction, browserNum);
      newPlanStep.failCount = planStep.failCount + 1;
      return { result, updatedPlanStep: newPlanStep, planUpdated: true };
    }

    // No plan: run normally with LLM (existing behavior)
    const result = await this.runSingleStep(instruction, browserNum);
    return { result };
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
