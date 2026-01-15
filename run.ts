import { config } from 'dotenv';
import { LangGraphTestRunner } from './langgraph-runner.js';

// Load .env file
config();

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Error: OPENROUTER_API_KEY environment variable not set');
    process.exit(1);
  }

  // Parse arguments, filtering out flags
  const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const testFile = args[0];
  const url = args[1] || 'https://latower.ch';

  if (!testFile) {
    console.error('Usage: npm run test:e2e <test-file> [url] [--diagram]');
    console.error('Example: npm run test:e2e scenarios/login-test.txt');
    console.error('Example: npm run test:e2e scenarios/login-test.txt --diagram');
    process.exit(1);
  }

  console.log(`Running test: ${testFile}`);
  console.log(`Target URL: ${url}\n`);

  // Create runner
  const runner = new LangGraphTestRunner(apiKey);

  // Generate workflow diagram if --diagram flag is present
  if (process.argv.includes('--diagram')) {
    await runner.saveWorkflowDiagram('workflow-diagram.md');
    console.log('✅ Workflow diagram generated\n');
  }

  // Run tests (browser 1 is default, url is starting URL)
  const finalState = await runner.runTestSuite(testFile, 1, url);

  // Exit with appropriate code
  const passed = finalState.results.filter((r: any) => r.success).length;
  const total = finalState.results.length;

  process.exit(passed === total ? 0 : 1);
}

main().catch(console.error);
