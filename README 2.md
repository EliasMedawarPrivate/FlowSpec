# E2E Test Automation with LangGraph

AI-powered end-to-end testing using Claude Agent SDK with LangGraph for structured test execution.

## Quick Start

1. Install dependencies:
```bash
npm install @langchain/openai @langchain/core @langchain/langgraph @modelcontextprotocol/sdk express socket.io dotenv tsx
```

2. Set up API key in `.env`:
```bash
OPENROUTER_API_KEY=your-openrouter-api-key
```

3. Run tests:

### Option A: Web UI (Recommended)
```bash
npm run test:e2e:ui
```
Then open http://localhost:3002 in your browser for a live testing dashboard with:
- Visual test editor
- Real-time execution logs
- Live results display
- Scenario management

### Option B: Command Line
```bash
npm run test:e2e tests/e2e/scenarios/login-test.txt
# Or with custom URL:
npm run test:e2e tests/e2e/scenarios/login-test.txt http://localhost:3000

# Generate workflow diagram:
npm run test:e2e tests/e2e/scenarios/login-test.txt --diagram
```

The `--diagram` flag generates a Mermaid diagram of the LangGraph workflow at [tests/e2e/workflow-diagram.md](workflow-diagram.md).

**Model**: Uses `nvidia/nemotron-3-nano-30b-a3b` via OpenRouter (affordable and fast)

**MCP Server**: Connects to MCP Chrome Bridge at `http://localhost:12306` for real browser automation.

## Test File Format

Create test files in `scenarios/` directory with the format:
```
instruction >>> expected result
instruction >>> expected result
```

Example `scenarios/login-test.txt`:
```
press on Login button >>> the login screen is shown
login as player with unique code : f30d9163-c472-4361-add3-888ebba2fd0 and pin :12345678 >>> pin is not correct and error is shown
```

## Features

- **LangGraph-based**: Structured workflow with state management
- **AI-powered**: Uses Nvidia Nemotron via OpenRouter to intelligently interact with your web app
- **MCP Browser Automation**: Leverages Model Context Protocol for browser control
- **Cost-effective**: Uses affordable Nvidia nano model

## Architecture

### High-Level Flow
```
┌─────────────────┐
│  Test Steps     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  LangGraph      │  State management
│  Workflow       │  Node-based execution
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  AI Model       │  Determines actions
│  (Nemotron)     │  via OpenRouter
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  MCP Browser    │  chrome_read_page
│  Automation     │  chrome_click_element
│                 │  chrome_fill_or_select
└─────────────────┘
```

### LangGraph Workflow Visualization

The test runner uses a LangGraph state machine with the following nodes:

1. **initialize** - Connect to MCP and navigate to starting URL
2. **readPage** - Read current page state
3. **executeStep** - Execute test step using AI
4. **nextStep** - Move to next test step
5. **finalize** - Display test summary

To visualize the complete workflow graph, run:
```bash
npm run test:e2e tests/e2e/scenarios/login-test.txt --diagram
```

This generates a Mermaid diagram at [workflow-diagram.md](workflow-diagram.md). See [WORKFLOW.md](WORKFLOW.md) for a detailed explanation with visual diagram.

## Usage

The `langgraph-runner.ts` file contains the `LangGraphTestRunner` class with methods:

- `runTest(url, steps)`: Execute a series of test steps
- State management through LangGraph nodes
- Automatic retry and error handling

See [langgraph-runner.ts](langgraph-runner.ts) for implementation details.
