const socket = io();
let currentTestId = null;
const scenariosData = [];
let currentScenario = null;
let isSaved = true;
let editorLines = [];
let runningLineIndex = null;
let browsersInitialized = false;

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
  }
}

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

  document.getElementById('runBtn').disabled = true;
  document.getElementById('results').innerHTML = '';
  document.getElementById('summary').style.display = 'none';

  const res = await fetch('/api/run-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario, startBrowser: false })
  });

  const { testId } = await res.json();
  currentTestId = testId;
  addLog(`🆔 Test ID: ${testId}`);
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
  editor.innerHTML = editorLines.map((line, index) => `
    <div class="line-row" data-index="${index}">
      <input type="number"
             class="line-number-input"
             value="${index + 1}"
             min="1"
             max="${editorLines.length}"
             onchange="moveLineToPosition(${index}, this.value)"
             onclick="this.select()"
             title="Edit to move line">
      <button class="line-play-btn ${runningLineIndex === index ? 'running' : ''}"
              onclick="runSingleLine(${index})"
              ${runningLineIndex !== null ? 'disabled' : ''}
              title="Run this line">
        ${runningLineIndex === index ? '⏳' : '▶'}
      </button>
      <input type="text"
             class="line-content"
             value="${escapeHtml(line)}"
             onchange="updateLine(${index}, this.value)"
             oninput="markUnsaved()">
      <span class="line-status" id="line-status-${index}"></span>
      <button class="line-delete-btn" onclick="deleteLine(${index})" title="Delete line">✕</button>
    </div>
  `).join('');
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

// Single line execution
async function runSingleLine(index) {
  const line = editorLines[index];
  if (!line) {
    alert('Empty line');
    return;
  }

  // Allow special commands without >>>
  if (!line.includes('>>>') && !isSpecialCommand(line)) {
    alert('Invalid line format. Use: instruction >>> expected result\nOr use special commands: "go to <url>", "reset session"');
    return;
  }

  runningLineIndex = index;
  renderEditor();

  // Clear previous status
  const statusEl = document.getElementById(`line-status-${index}`);
  if (statusEl) statusEl.textContent = '';

  addLog(`\n🎯 Running single line ${index + 1}: ${line.substring(0, 50)}...`);

  try {
    const res = await fetch('/api/run-single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: line,
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

// Handle single line completion
socket.on('single-line-result', ({ testId, result }) => {
  if (testId !== currentTestId) return;

  const index = runningLineIndex;
  runningLineIndex = null;
  renderEditor();

  if (result && index !== null) {
    const statusEl = document.getElementById(`line-status-${index}`);
    if (statusEl) {
      statusEl.textContent = result.success ? '✅' : '❌';
    }

    // Also show in results
    displayResults([result], { total: 1, passed: result.success ? 1 : 0, failed: result.success ? 0 : 1 });
  }
});
