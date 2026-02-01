const socket = io();
let currentTestId = null;
const scenariosData = [];
let currentScenario = null;
let isSaved = true;
let editorLines = [];
let runningLineIndex = null;
let continueToNextLine = false; // Flag to auto-run next line after current completes
let runFromLineActive = false; // Flag for "run from here" mode (>> button)
let browsersInitialized = false;
let learningMode = false;
let currentPlan = null;
let includeSourceScenario = null; // The ##file.txt currently being expanded
let includedPlans = {}; // Cache: { 'login-player.txt': planObj }

// Load scenarios on startup
loadScenarios();
initializeEditor();
loadBrowserState();

function updateSaveStatus() {
  const saveBtn = document.querySelector('button[onclick="saveScenario()"]');
  if (!isSaved && currentScenario) {
    saveBtn.textContent = '💾 Save (Not saved)';
    saveBtn.style.background = '#f59e0b';
  } else {
    saveBtn.textContent = '💾 Save Scenario';
    saveBtn.style.background = '';
  }
}

async function loadScenarios() {
  const res = await fetch('/api/scenarios');
  const scenarios = await res.json();
  scenariosData.length = 0;
  scenariosData.push(...scenarios);

  const list = document.getElementById('scenarios');
  list.innerHTML = scenarios.map((s, i) =>
    `<div class="scenario-item" onclick="loadScenarioByIndex(${i})">${s.name}</div>`
  ).join('');
}

function loadScenarioByIndex(index) {
  const scenario = scenariosData[index];
  if (scenario) {
    currentScenario = scenario.name;
    document.getElementById('scenarioName').value = scenario.name;
    setScenarioContent(scenario.content);
    isSaved = true;
    updateSaveStatus();
    loadPlanForScenario();
  }
}

// ===== Learning Mode & Plan Functions =====

function toggleLearningMode() {
  learningMode = !learningMode;
  const btn = document.getElementById('learnModeBtn');
  btn.textContent = learningMode ? 'Learning Mode: ON' : 'Learning Mode: OFF';
  btn.className = learningMode ? 'learning-active' : 'secondary';
  document.getElementById('modeHint').textContent = learningMode
    ? 'Recording actions into plan'
    : 'Normal mode';
  renderEditor();
}

async function loadPlanForScenario() {
  if (!currentScenario) {
    currentPlan = null;
    updatePlanInfo();
    return;
  }
  try {
    const name = currentScenario.replace('.txt', '');
    const res = await fetch(`/api/plans/${name}`);
    if (res.ok) {
      currentPlan = await res.json();
    } else {
      currentPlan = null;
    }
  } catch {
    currentPlan = null;
  }
  updatePlanInfo();
  renderEditor();
}

function updatePlanInfo() {
  const info = document.getElementById('planInfo');
  const status = document.getElementById('planStatus');
  if (currentPlan && currentPlan.steps && currentPlan.steps.length > 0) {
    const learned = currentPlan.steps.filter(s => s.learnedAt).length;
    const total = currentPlan.steps.length;
    info.style.display = 'flex';
    status.textContent = `Plan: ${learned}/${total} steps learned`;
  } else {
    info.style.display = 'none';
  }
}

async function deletePlan() {
  if (!currentScenario) return;
  if (!confirm('Delete the execution plan for this scenario?')) return;
  try {
    const name = currentScenario.replace('.txt', '');
    await fetch(`/api/plans/${name}`, { method: 'DELETE' });
    currentPlan = null;
    updatePlanInfo();
    renderEditor();
    addLog('Plan deleted');
  } catch (e) {
    addLog('Failed to delete plan');
  }
}

function getPlanStepForLine(line) {
  if (!currentPlan || !currentPlan.steps) return null;
  return currentPlan.steps.find(s => s.originalInstruction === line.trim()) || null;
}

// Load and cache a plan for an included file
async function loadIncludedPlan(scenarioName) {
  if (includedPlans[scenarioName]) return includedPlans[scenarioName];
  try {
    const name = scenarioName.replace('.txt', '');
    const res = await fetch(`/api/plans/${name}`);
    if (res.ok) {
      includedPlans[scenarioName] = await res.json();
      return includedPlans[scenarioName];
    }
  } catch {}
  return null;
}

// Look up a plan step from the included file's plan
function getIncludedPlanStep(instruction) {
  if (!includeSourceScenario || !includedPlans[includeSourceScenario]) return null;
  const plan = includedPlans[includeSourceScenario];
  return plan.steps?.find(s => s.originalInstruction === instruction.trim()) || null;
}

// Listen for plan updates from server
socket.on('plan-updated', ({ scenarioName }) => {
  if (currentScenario === scenarioName) {
    loadPlanForScenario();
  }
  // Invalidate cached included plans
  if (includedPlans[scenarioName]) {
    delete includedPlans[scenarioName];
  }
});

async function saveScenario() {
  const name = document.getElementById('scenarioName').value;
  const content = getScenarioContent();

  if (!name || !content) {
    alert('Please provide both name and content');
    return;
  }

  const res = await fetch('/api/scenarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content })
  });

  if (res.ok) {
    currentScenario = name;
    isSaved = true;
    updateSaveStatus();
    addLog('✅ Scenario saved: ' + name);
    loadScenarios();
  } else {
    addLog('❌ Failed to save scenario');
  }
}

async function runTest() {
  const scenario = getScenarioContent();

  if (!scenario) {
    alert('Please provide a test scenario');
    return;
  }

  if (!browsersInitialized) {
    alert('Please initialize browsers first');
    return;
  }

  document.getElementById('results').innerHTML = '';
  document.getElementById('summary').style.display = 'none';

  // Use runFromLine(0) so all lines go through the plan system
  runFromLine(0);
}

// Browser initialization
async function loadBrowserState() {
  try {
    const res = await fetch('/api/browsers');
    const data = await res.json();

    updateBrowserStatus(1, data.browser1);
    updateBrowserStatus(2, data.browser2);

    if (data.browser1.connected && data.browser2.connected) {
      browsersInitialized = true;
    }
  } catch (error) {
    console.error('Failed to load browser state:', error);
  }
}

function updateBrowserStatus(num, state) {
  const dot = document.getElementById(`browser${num}Status`);
  if (dot) {
    dot.className = 'status-dot' + (state.connected ? ' connected' : '');
  }
}

async function initBrowsers() {
  const url1 = document.getElementById('browserUrl1').value;
  const url2 = document.getElementById('browserUrl2').value;

  const initBtn = document.getElementById('initBtn');
  initBtn.disabled = true;
  initBtn.textContent = '⏳ Initializing...';

  addLog('🌐 Initializing browsers...');
  addLog(`   Browser 1: ${url1}`);
  addLog(`   Browser 2: ${url2}`);

  try {
    const res = await fetch('/api/init-browsers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url1, url2 })
    });

    const data = await res.json();

    if (res.ok) {
      browsersInitialized = true;
      addLog(`✅ Browser 1 ready: tab=${data.browser1.tabId}, window=${data.browser1.windowId}`);
      addLog(`✅ Browser 2 ready: tab=${data.browser2.tabId}, window=${data.browser2.windowId}`);
      updateBrowserStatus(1, { connected: true });
      updateBrowserStatus(2, { connected: true });
    } else {
      addLog(`❌ Failed to initialize browsers: ${data.error}`);
    }
  } catch (error) {
    addLog(`❌ Error initializing browsers: ${error.message}`);
  } finally {
    initBtn.disabled = false;
    initBtn.textContent = '🌐 Init Browsers';
  }
}

// Listen for browser initialization events
socket.on('browsers-initialized', (data) => {
  updateBrowserStatus(1, data.browser1);
  updateBrowserStatus(2, data.browser2);
  browsersInitialized = data.browser1.connected && data.browser2.connected;
});

socket.on('test-log', ({ testId, message }) => {
  if (testId === currentTestId) {
    addLog(message);
  }
});

socket.on('test-progress', ({ testId, status, results, summary }) => {
  if (testId !== currentTestId) return;

  if (status === 'completed' && results) {
    displayResults(results, summary);
    document.getElementById('runBtn').disabled = false;
  } else if (status === 'failed') {
    document.getElementById('runBtn').disabled = false;
  }
});

function addLog(message) {
  const logs = document.getElementById('logs');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = message;
  logs.appendChild(line);
  logs.scrollTop = logs.scrollHeight;
}

function clearLogs() {
  document.getElementById('logs').innerHTML = '';
}

async function resetSession() {
  addLog('🔄 Resetting session...');

  try {
    const res = await fetch('/api/reset-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    const result = await res.json();

    if (res.ok) {
      addLog('✅ Session reset successfully (localStorage cleared)');
    } else {
      addLog('❌ Failed to reset session: ' + result.error);
    }
  } catch (error) {
    addLog('❌ Error resetting session: ' + error.message);
  }
}

function displayResults(results, summary) {
  const resultsDiv = document.getElementById('results');
  resultsDiv.innerHTML = results.map((r, i) => `
    <div class="result-item ${r.success ? 'success' : 'failed'}">
      <div class="result-header">
        <span class="status-badge ${r.success ? 'success' : 'failed'}">${r.success ? '✓ PASS' : '✗ FAIL'}</span>
        <strong>Step ${i + 1}</strong>
      </div>
      <div style="margin: 5px 0;"><strong>Instruction:</strong> ${r.instruction}</div>
      <div style="margin: 5px 0; color: #94a3b8;"><strong>Expected:</strong> ${r.expectedResult}</div>
      <div style="margin: 5px 0; color: #cbd5e1;"><strong>Result:</strong> ${r.actualResult}</div>
    </div>
  `).join('');

  document.getElementById('summary').style.display = 'flex';
  document.getElementById('totalTests').textContent = summary.total;
  document.getElementById('passedTests').textContent = summary.passed;
  document.getElementById('failedTests').textContent = summary.failed;
}

// Line Editor Functions
function initializeEditor() {
  // Initialize with default lines
  editorLines = [
    'find and click the login or sign in button >>> the login form appears',
    'enter unique code test-123 in the code field >>> the code is entered'
  ];
  renderEditor();
}

function renderEditor() {
  const editor = document.getElementById('lineEditor');
  editor.innerHTML = editorLines.map((line, index) => {
    const planStep = getPlanStepForLine(line);
    const hasplan = planStep && planStep.learnedAt;
    const planIndicator = hasplan
      ? (planStep.failCount > 2 ? '<span class="plan-indicator warn" title="Unreliable plan step">!</span>'
         : '<span class="plan-indicator learned" title="Learned plan step">P</span>')
      : '';

    return `
    <div class="line-row" data-index="${index}">
      <input type="number"
             class="line-number-input"
             value="${index + 1}"
             min="1"
             max="${editorLines.length}"
             onchange="moveLineToPosition(${index}, this.value)"
             onclick="this.select()"
             title="Edit to move line">
      ${planIndicator}
      <button class="line-play-btn ${runningLineIndex === index ? 'running' : ''}"
              onclick="runSingleLine(${index}, event)"
              ${runningLineIndex !== null ? 'disabled' : ''}
              title="${hasplan && !learningMode ? 'Run with plan (fast)' : 'Run this line'}">
        ${runningLineIndex === index ? '⏳' : (hasplan && !learningMode ? '⚡' : '▶')}
      </button>
      <button class="line-play-all-btn"
              onclick="runFromLine(${index})"
              ${runningLineIndex !== null ? 'disabled' : ''}
              title="Run from this line to end">
        ▶▶
      </button>
      <input type="text"
             class="line-content"
             value="${escapeHtml(line)}"
             onchange="updateLine(${index}, this.value)"
             oninput="markUnsaved()">
      <span class="line-status" id="line-status-${index}"></span>
      <button class="line-delete-btn" onclick="deleteLine(${index})" title="Delete line">✕</button>
    </div>
  `}).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML.replace(/"/g, '&quot;');
}

function updateLine(index, value) {
  editorLines[index] = value;
  isSaved = false;
  updateSaveStatus();
}

function markUnsaved() {
  isSaved = false;
  updateSaveStatus();
}

function deleteLine(index) {
  editorLines.splice(index, 1);
  isSaved = false;
  updateSaveStatus();
  renderEditor();
}

function moveLineToPosition(fromIndex, toPositionStr) {
  const toPosition = parseInt(toPositionStr);
  if (isNaN(toPosition)) return;

  // Convert 1-based position to 0-based index
  const toIndex = toPosition - 1;

  // Validate bounds
  if (toIndex < 0 || toIndex >= editorLines.length || toIndex === fromIndex) {
    renderEditor(); // Reset the input to correct value
    return;
  }

  // Remove the line from its current position
  const [line] = editorLines.splice(fromIndex, 1);

  // Insert at new position
  editorLines.splice(toIndex, 0, line);

  isSaved = false;
  updateSaveStatus();
  renderEditor();
}

function addNewLine() {
  const input = document.getElementById('newLineInput');
  const value = input.value.trim();
  if (value) {
    editorLines.push(value);
    input.value = '';
    isSaved = false;
    updateSaveStatus();
    renderEditor();
  }
}

function handleNewLineKeypress(event) {
  if (event.key === 'Enter') {
    addNewLine();
  }
}

function getScenarioContent() {
  return editorLines.filter(line => line.trim()).join('\n');
}

function setScenarioContent(content) {
  editorLines = content.split('\n').filter(line => line.trim());
  renderEditor();
}

// Check if a line is a special command (no >>> needed)
function isSpecialCommand(line) {
  // Remove browser prefix first
  const cleanLine = line.replace(/^\*[12]\s+/, '').trim().toLowerCase();

  // Check for "go to <url>" or "navigate to <url>"
  if (/^(?:go\s+to|navigate\s+to)\s+.+$/i.test(cleanLine)) {
    return true;
  }

  // Check for "reset session" / "reset storage" / "clear session" / "clear storage"
  if (/^(?:reset|clear)\s+(?:session|storage|localstorage)$/i.test(cleanLine)) {
    return true;
  }

  return false;
}

// Resolve ##include lines into their constituent steps
function resolveIncludeLines(line) {
  const includeMatch = line.trim().match(/^##(.+\.txt)$/i);
  if (!includeMatch) return null;

  const fileName = includeMatch[1];
  const scenario = scenariosData.find(s => s.name === fileName);
  if (!scenario) {
    alert(`Include file not found: ${fileName}\nMake sure the scenario "${fileName}" exists.`);
    return null;
  }

  return scenario.content
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

// Queue for running expanded include lines
let includeQueue = [];
let includeRunning = false;
let includeOriginalIndex = null;

// Run the next line in the include queue
// Queue items are { instruction, sourceScenario } objects
function runNextIncludeLine() {
  if (includeQueue.length === 0) {
    includeRunning = false;
    // Mark the original ##include line as passed
    if (includeOriginalIndex !== null) {
      const statusEl = document.getElementById(`line-status-${includeOriginalIndex}`);
      if (statusEl) statusEl.textContent = '✅';
    }
    includeOriginalIndex = null;
    includeSourceScenario = null;
    runningLineIndex = null;
    renderEditor();

    // If run-from-here is active, continue to the next editor line
    if (runFromLineActive && includeOriginalIndex !== null) return;
    return;
  }

  const item = includeQueue.shift();
  const instruction = typeof item === 'string' ? item : item.instruction;
  const sourceScenario = (typeof item === 'object' && item.sourceScenario) || includeSourceScenario;

  // Check if this sub-line is itself an include
  const subInclude = resolveIncludeLines(instruction);
  if (subInclude) {
    const subMatch = instruction.trim().match(/^##(.+\.txt)$/i);
    const nestedSource = subMatch ? subMatch[1] : sourceScenario;
    // Tag each expanded line with the nested include's scenario name
    const taggedLines = subInclude.map(line => ({ instruction: line, sourceScenario: nestedSource }));
    // Load nested include's plan, then continue
    if (nestedSource && nestedSource !== sourceScenario) {
      loadIncludedPlan(nestedSource).then(() => {
        addLog(`📂 Expanding nested include: ${instruction}`);
        includeQueue = taggedLines.concat(includeQueue);
        runNextIncludeLine();
      });
      return;
    }
    addLog(`📂 Expanding nested include: ${instruction}`);
    includeQueue = taggedLines.concat(includeQueue);
    runNextIncludeLine();
    return;
  }

  // Use included file's plan for step lookup
  includeSourceScenario = sourceScenario;
  const inclPlan = includedPlans[sourceScenario];
  const inclPlanStep = inclPlan?.steps?.find(s => s.originalInstruction === instruction.trim()) || null;

  let inclEndpoint = '/api/run-single';
  if (learningMode) {
    if (inclPlanStep && inclPlanStep.learnedAt) {
      // Already learned in included file's plan — replay instead of re-learning
      inclEndpoint = '/api/run-single-plan';
      addLog(`\n⚡ [include] Replaying learned step: ${instruction.substring(0, 60)}...`);
    } else {
      inclEndpoint = '/api/learn-single';
      addLog(`\n📚 [include] Learning: ${instruction.substring(0, 60)}...`);
    }
  } else if (inclPlanStep && inclPlanStep.learnedAt) {
    inclEndpoint = '/api/run-single-plan';
    addLog(`\n⚡ [include] Replaying: ${instruction.substring(0, 60)}...`);
  } else {
    addLog(`\n🎯 [include] Running: ${instruction.substring(0, 60)}...`);
  }

  // Use the included file's scenario name so plans are saved per-file
  const scenarioName = sourceScenario || currentScenario || 'untitled.txt';

  fetch(inclEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction, scenarioName, useExistingTab: true })
  }).then(res => res.json())
    .then(({ testId }) => {
      currentTestId = testId;
    })
    .catch(error => {
      addLog(`❌ Error: ${error.message}`);
      includeQueue = [];
      includeRunning = false;
      includeSourceScenario = null;
      runningLineIndex = null;
      renderEditor();
    });
}

// Single line execution
async function runSingleLine(index, event) {
  const line = editorLines[index];
  if (!line) {
    alert('Empty line');
    return;
  }

  // Handle ##include lines - expand and run all included steps
  const includedLines = resolveIncludeLines(line);
  if (includedLines) {
    const includeMatch = line.trim().match(/^##(.+\.txt)$/i);
    includeSourceScenario = includeMatch ? includeMatch[1] : null;
    addLog(`\n📂 Expanding include: ${line} (${includedLines.length} steps)`);
    // Tag each line with its source scenario for correct plan file routing
    includeQueue = includedLines.map(l => ({ instruction: l, sourceScenario: includeSourceScenario }));
    includeRunning = true;
    includeOriginalIndex = index;
    runningLineIndex = index;
    renderEditor();
    // Load included file's plan before running, then start queue
    if (includeSourceScenario) {
      loadIncludedPlan(includeSourceScenario).then(() => runNextIncludeLine());
    } else {
      runNextIncludeLine();
    }
    return;
  }

  // Check if Ctrl key was held (continue to next line)
  continueToNextLine = event && (event.ctrlKey || event.metaKey);

  runningLineIndex = index;
  renderEditor();

  // Clear previous status
  const statusEl = document.getElementById(`line-status-${index}`);
  if (statusEl) statusEl.textContent = '';

  // Determine endpoint based on mode
  const planStep = getPlanStepForLine(line);
  let endpoint = '/api/run-single';
  let modeLabel = 'Running';

  if (learningMode) {
    endpoint = '/api/learn-single';
    modeLabel = 'Learning';
  } else if (planStep && planStep.learnedAt) {
    endpoint = '/api/run-single-plan';
    modeLabel = 'Replaying plan';
  }

  addLog(`\n🎯 ${modeLabel} line ${index + 1}: ${line.substring(0, 50)}...`);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: line,
        scenarioName: currentScenario || 'untitled.txt',
        useExistingTab: true
      })
    });

    const { testId } = await res.json();
    currentTestId = testId;
    addLog(`🆔 Test ID: ${testId}`);
  } catch (error) {
    addLog(`❌ Error: ${error.message}`);
    runningLineIndex = null;
    renderEditor();
  }
}

// Run from a specific line through all remaining lines
async function runFromLine(index) {
  runFromLineActive = true;
  runSingleLine(index);
}

// Handle single line completion
socket.on('single-line-result', ({ testId, result }) => {
  if (testId !== currentTestId) return;

  // If we're running an include queue, handle sub-step completion
  if (includeRunning) {
    const success = result && result.success;
    addLog(`${success ? '✅' : '❌'} [include] ${result ? result.actualResult : 'No result'}`);
    displayResults([result], { total: 1, passed: success ? 1 : 0, failed: success ? 0 : 1 });

    if (success && includeQueue.length > 0) {
      // Continue with next include sub-step
      setTimeout(() => runNextIncludeLine(), 100);
    } else {
      // Include finished (success or failure)
      const origIndex = includeOriginalIndex;
      includeRunning = false;
      includeQueue = [];
      includeOriginalIndex = null;
      runningLineIndex = null;
      renderEditor();

      if (origIndex !== null) {
        const statusEl = document.getElementById(`line-status-${origIndex}`);
        if (statusEl) statusEl.textContent = success ? '✅' : '❌';
      }

      // If run-from-here is active, continue to next editor line
      if (runFromLineActive && success && origIndex !== null && origIndex + 1 < editorLines.length) {
        addLog(`\n⏭️ Continuing to next line...`);
        setTimeout(() => runSingleLine(origIndex + 1), 100);
      } else {
        runFromLineActive = false;
      }
    }
    return;
  }

  const index = runningLineIndex;
  const shouldContinue = continueToNextLine || runFromLineActive;
  runningLineIndex = null;
  continueToNextLine = false;
  renderEditor();

  if (result && index !== null) {
    const statusEl = document.getElementById(`line-status-${index}`);
    if (statusEl) {
      statusEl.textContent = result.success ? '✅' : '❌';
    }

    // Also show in results
    displayResults([result], { total: 1, passed: result.success ? 1 : 0, failed: result.success ? 0 : 1 });

    // If run-from-here or Ctrl was held and there's a next line, run it automatically
    if (shouldContinue && result.success && index + 1 < editorLines.length) {
      addLog(`\n⏭️ Continuing to next line...`);
      // Use setTimeout to ensure UI updates before next execution
      setTimeout(() => runSingleLine(index + 1), 100);
    } else {
      // Stop chaining - either failed, last line, or not in continue mode
      runFromLineActive = false;
    }
  } else {
    runFromLineActive = false;
  }
});
