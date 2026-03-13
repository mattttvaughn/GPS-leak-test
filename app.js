import {
  ANALYSIS_THRESHOLDS,
  addSample,
  analyzeSession,
  buildMockCases,
  haversineDistanceMeters,
  runMockAnalyses,
} from "./analyzer.mjs";

const GEO_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 10_000,
};

const SOFT_STOP_MS = 45_000;
const HARD_STOP_MS = 60_000;

const elements = {
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  clearButton: document.getElementById("clearButton"),
  permissionState: document.getElementById("permissionState"),
  statusMessage: document.getElementById("statusMessage"),
  debugBody: document.getElementById("debugBody"),
  reasonsList: document.getElementById("reasonsList"),
  riskScore: document.getElementById("riskScore"),
  classificationLabel: document.getElementById("classificationLabel"),
  mockCaseSelect: document.getElementById("mockCaseSelect"),
  runMockCaseButton: document.getElementById("runMockCaseButton"),
  runAllMockButton: document.getElementById("runAllMockButton"),
  mockResultsBody: document.getElementById("mockResultsBody"),
  summaryBaselineDelta: document.getElementById("summary-baselineDelta"),
};

const liveFieldIds = ["lat", "lng", "accuracy", "altitude", "heading", "speed", "timestamp"];
const summaryFieldIds = [
  "samples",
  "elapsed",
  "totalDistance",
  "avgSpeed",
  "maxSpeed",
  "largeJumps",
  "identicalCoords",
  "timestampAnomalies",
  "accuracyVariance",
  "oddFields",
];

const state = {
  samples: [],
  watchId: null,
  softStopTimer: null,
  hardStopTimer: null,
  running: false,
  permissionStatusRef: null,
  sessionStartedAtMs: null,
  baselineSample: null,
  mockCases: buildMockCases(),
};

function byLiveField(name) {
  return document.getElementById(`live-${name}`);
}

function bySummaryField(name) {
  return document.getElementById(`summary-${name}`);
}

function setStatus(message) {
  elements.statusMessage.textContent = message;
}

function setPermissionState(label) {
  elements.permissionState.textContent = label;
}

function setControls({ running }) {
  elements.startButton.disabled = running;
  elements.stopButton.disabled = !running;
}

function formatNumber(value, fractionDigits = 2) {
  if (value === null || value === undefined) return "-";
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(fractionDigits);
}

function formatMeters(value) {
  return `${formatNumber(value, 1)} m`;
}

function formatSpeed(value) {
  return `${formatNumber(value, 2)} m/s`;
}

function formatTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${new Date(value).toLocaleTimeString()} (${value})`;
}

function extractSample(position) {
  const { coords, timestamp } = position;
  return {
    lat: Number.isFinite(coords.latitude) ? coords.latitude : null,
    lng: Number.isFinite(coords.longitude) ? coords.longitude : null,
    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
    altitude: Number.isFinite(coords.altitude) ? coords.altitude : null,
    altitudeAccuracy: Number.isFinite(coords.altitudeAccuracy) ? coords.altitudeAccuracy : null,
    heading: Number.isFinite(coords.heading) ? coords.heading : null,
    speed: Number.isFinite(coords.speed) ? coords.speed : null,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  };
}

async function refreshPermissionState() {
  if (!("geolocation" in navigator)) {
    setPermissionState("unavailable");
    return;
  }

  if (!navigator.permissions || !navigator.permissions.query) {
    setPermissionState("unavailable");
    return;
  }

  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    state.permissionStatusRef = status;
    setPermissionState(status.state);
    status.onchange = () => setPermissionState(status.state);
  } catch {
    setPermissionState("unavailable");
  }
}

function clearTimers() {
  if (state.softStopTimer) {
    clearTimeout(state.softStopTimer);
    state.softStopTimer = null;
  }
  if (state.hardStopTimer) {
    clearTimeout(state.hardStopTimer);
    state.hardStopTimer = null;
  }
}

function setupAutoStopTimers() {
  clearTimers();

  state.softStopTimer = setTimeout(() => {
    const result = analyzeSession(state.samples, { collectionNowMs: Date.now() });
    if (result.risk.ready) {
      stopCollection("Auto-stopped after 45 seconds (minimum analysis threshold met).");
      return;
    }
    setStatus("Sample flow is slow. Extending collection to 60 seconds to reach minimum analysis threshold.");
  }, SOFT_STOP_MS);

  state.hardStopTimer = setTimeout(() => {
    stopCollection("Auto-stopped after 60 seconds.");
  }, HARD_STOP_MS);
}

function resetLivePanel() {
  liveFieldIds.forEach((fieldName) => {
    byLiveField(fieldName).textContent = "-";
  });
}

function resetSummaryPanel() {
  bySummaryField("samples").textContent = "0";
  bySummaryField("elapsed").textContent = "0s";
  bySummaryField("totalDistance").textContent = "0 m";
  bySummaryField("latestHopDistance").textContent = "0 m";
  bySummaryField("latestHopSpeed").textContent = "0 m/s";
  bySummaryField("avgSpeed").textContent = "0 m/s";
  bySummaryField("maxSpeed").textContent = "0 m/s";
  bySummaryField("largeJumps").textContent = "0";
  bySummaryField("identicalCoords").textContent = "0";
  bySummaryField("timestampAnomalies").textContent = "0";
  bySummaryField("accuracyVariance").textContent = "0";
  bySummaryField("oddFields").textContent = "0";
  elements.riskScore.textContent = "0";
  elements.classificationLabel.textContent = "Not enough data";
  elements.summaryBaselineDelta.textContent = "n/a";
  elements.reasonsList.innerHTML =
    "<li>Collect at least 4 samples across 15+ seconds for minimum viable analysis.</li>";
}

function clearDebugTable() {
  elements.debugBody.innerHTML = "";
}

function clearSessionView() {
  resetLivePanel();
  resetSummaryPanel();
  clearDebugTable();
}

function renderLiveSample(sample) {
  byLiveField("lat").textContent = formatNumber(sample.lat, 7);
  byLiveField("lng").textContent = formatNumber(sample.lng, 7);
  byLiveField("accuracy").textContent = sample.accuracy === null ? "-" : formatMeters(sample.accuracy);
  byLiveField("altitude").textContent = sample.altitude === null ? "-" : formatNumber(sample.altitude, 1);
  byLiveField("heading").textContent = sample.heading === null ? "-" : `${formatNumber(sample.heading, 1)}°`;
  byLiveField("speed").textContent = sample.speed === null ? "-" : formatSpeed(sample.speed);
  byLiveField("timestamp").textContent = formatTimestamp(sample.timestamp);
}

function renderReasons(reasons) {
  elements.reasonsList.innerHTML = "";
  reasons.forEach((reason) => {
    const li = document.createElement("li");
    li.textContent = reason;
    elements.reasonsList.appendChild(li);
  });
}

function renderDebugTable(samples, metrics) {
  elements.debugBody.innerHTML = "";
  samples.forEach((sample, index) => {
    const pair = metrics.pairs[index - 1] ?? null;
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${formatTimestamp(sample.timestamp)}</td>
      <td>${formatNumber(sample.lat, 7)}</td>
      <td>${formatNumber(sample.lng, 7)}</td>
      <td>${formatNumber(sample.accuracy, 1)}</td>
      <td>${formatNumber(sample.altitude, 1)}</td>
      <td>${formatNumber(sample.heading, 1)}</td>
      <td>${formatNumber(sample.speed, 2)}</td>
      <td>${pair ? formatNumber(pair.timeDeltaMs, 0) : "-"}</td>
      <td>${pair ? formatNumber(pair.distanceMeters, 1) : "-"}</td>
      <td>${pair ? formatNumber(pair.impliedSpeedMps, 2) : "-"}</td>
    `;
    elements.debugBody.appendChild(row);
  });
}

function renderSummary(samples, analysis) {
  const { metrics, risk } = analysis;
  const latestPair = metrics.pairs[metrics.pairs.length - 1] ?? null;
  bySummaryField("samples").textContent = String(samples.length);
  bySummaryField("elapsed").textContent = `${(metrics.elapsedMs / 1000).toFixed(1)}s`;
  bySummaryField("totalDistance").textContent = formatMeters(metrics.totalDistance);
  bySummaryField("latestHopDistance").textContent = latestPair ? formatMeters(latestPair.distanceMeters) : "0 m";
  bySummaryField("latestHopSpeed").textContent = latestPair ? formatSpeed(latestPair.impliedSpeedMps) : "0 m/s";
  bySummaryField("avgSpeed").textContent = formatSpeed(metrics.averageImpliedSpeed);
  bySummaryField("maxSpeed").textContent = formatSpeed(metrics.maxImpliedSpeed);
  bySummaryField("largeJumps").textContent = String(metrics.largeJumpCount);
  bySummaryField("identicalCoords").textContent = String(metrics.repeatedIdenticalCoordinates);
  bySummaryField("timestampAnomalies").textContent = String(metrics.timestampAnomalies);
  bySummaryField("accuracyVariance").textContent = formatNumber(metrics.accuracyVariance, 2);
  bySummaryField("oddFields").textContent = String(metrics.oddFieldCount);
  elements.riskScore.textContent = String(risk.score);
  elements.classificationLabel.textContent = risk.label;
  renderReasons(risk.reasons);

  renderDebugTable(samples, metrics);
}

function updateBaselineDelta() {
  if (!state.baselineSample || !state.samples.length) {
    elements.summaryBaselineDelta.textContent = "n/a";
    return;
  }
  const distance = haversineDistanceMeters(state.baselineSample, state.samples[0]);
  elements.summaryBaselineDelta.textContent = formatMeters(distance);
}

function processSample(sample) {
  state.samples = addSample(state.samples, sample);
  renderLiveSample(sample);
  const analysis = analyzeSession(state.samples, { collectionNowMs: Date.now() });
  renderSummary(state.samples, analysis);
  updateBaselineDelta();
  setStatus(`Collecting samples (${state.samples.length})...`);
}

function onWatchSuccess(position) {
  processSample(extractSample(position));
}

function onWatchError(error) {
  const code = error?.code;
  if (code === 1) {
    setPermissionState("denied");
    setStatus("Location permission denied. Enable location access in browser settings, then retry.");
    stopCollection();
    return;
  }

  if (code === 2) {
    setStatus("Location unavailable right now. Waiting for next reading.");
    return;
  }

  if (code === 3) {
    setStatus("Location request timed out for one attempt. Continuing to watch for next sample.");
    return;
  }

  setStatus(`Geolocation error: ${error?.message ?? "unknown error"}.`);
}

function stopCollection(message = "Collection stopped.") {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  clearTimers();
  state.running = false;
  setControls({ running: false });

  if (message) {
    setStatus(message);
  }

  if (state.samples.length === 1) {
    elements.classificationLabel.textContent = "Not enough data";
    renderReasons(["Only one sample collected. Need additional readings to estimate consistency."]);
  }
}

function clearSession() {
  if (state.running) stopCollection();
  state.samples = [];
  state.sessionStartedAtMs = null;
  state.baselineSample = null;
  clearSessionView();
  setStatus("Session cleared. Ready to start.");
}

function captureBaseline() {
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.baselineSample = extractSample(position);
      updateBaselineDelta();
    },
    () => {
      state.baselineSample = null;
      elements.summaryBaselineDelta.textContent = "n/a";
    },
    GEO_OPTIONS,
  );
}

function startCollection() {
  if (!("geolocation" in navigator)) {
    setPermissionState("unavailable");
    setStatus("Geolocation API is unavailable in this browser.");
    return;
  }

  if (state.running) return;

  state.samples = [];
  state.sessionStartedAtMs = Date.now();
  state.baselineSample = null;
  clearSessionView();
  setStatus("Requesting location permission and starting geolocation watch...");

  state.running = true;
  setControls({ running: true });

  captureBaseline();

  state.watchId = navigator.geolocation.watchPosition(onWatchSuccess, onWatchError, GEO_OPTIONS);
  setupAutoStopTimers();
}

function renderMockResults(results) {
  elements.mockResultsBody.innerHTML = "";
  results.forEach((result) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${result.name}</td>
      <td>${result.risk.score}</td>
      <td>${result.risk.label}</td>
      <td>${result.risk.reasons.join(" | ")}</td>
    `;
    elements.mockResultsBody.appendChild(row);
  });
}

function runSelectedMockCase() {
  const id = elements.mockCaseSelect.value;
  const match = state.mockCases.find((scenario) => scenario.id === id);
  if (!match) return;
  const collectionNowMs = (match.samples[match.samples.length - 1]?.timestamp ?? Date.now()) + 500;
  const result = analyzeSession(match.samples, { collectionNowMs });
  renderMockResults([{ name: match.name, risk: result.risk }]);
}

function runAllMockCases() {
  renderMockResults(runMockAnalyses());
}

function initMockCaseSelector() {
  elements.mockCaseSelect.innerHTML = "";
  state.mockCases.forEach((scenario) => {
    const option = document.createElement("option");
    option.value = scenario.id;
    option.textContent = scenario.name;
    elements.mockCaseSelect.appendChild(option);
  });
}

function attachEvents() {
  elements.startButton.addEventListener("click", startCollection);
  elements.stopButton.addEventListener("click", () => stopCollection("Stopped by user."));
  elements.clearButton.addEventListener("click", clearSession);
  elements.runMockCaseButton.addEventListener("click", runSelectedMockCase);
  elements.runAllMockButton.addEventListener("click", runAllMockCases);
}

function init() {
  setControls({ running: false });
  clearSessionView();
  initMockCaseSelector();
  runAllMockCases();
  attachEvents();
  refreshPermissionState();
  if (!("geolocation" in navigator)) {
    setPermissionState("unavailable");
    setStatus("Geolocation API is unavailable in this browser.");
  }
}

init();
