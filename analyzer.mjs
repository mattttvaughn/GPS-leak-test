const MIN_SAMPLES = 4;
const MIN_DURATION_MS = 15_000;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function variance(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / values.length;
}

function roundCoord(value, decimals = 7) {
  if (!isFiniteNumber(value)) return null;
  return Number(value.toFixed(decimals));
}

export function haversineDistanceMeters(a, b) {
  if (!a || !b || !isFiniteNumber(a.lat) || !isFiniteNumber(a.lng) || !isFiniteNumber(b.lat) || !isFiniteNumber(b.lng)) {
    return 0;
  }

  const R = 6_371_000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const deltaLat = ((b.lat - a.lat) * Math.PI) / 180;
  const deltaLng = ((b.lng - a.lng) * Math.PI) / 180;

  const x =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function addSample(samples, sample) {
  return [...samples, sample];
}

function headingDeltaDegrees(prevHeading, nextHeading) {
  if (!isFiniteNumber(prevHeading) || !isFiniteNumber(nextHeading)) return null;
  const raw = Math.abs((nextHeading - prevHeading) % 360);
  return raw > 180 ? 360 - raw : raw;
}

function classifyAccuracyDelta(previous, current) {
  if (!isFiniteNumber(previous) || !isFiniteNumber(current)) return "unknown";
  if (current < previous) return "improved";
  if (current > previous) return "worsened";
  return "unchanged";
}

function summarizeIdenticalCoordinateRuns(samples) {
  let longestRun = 1;
  let suspiciousRunLength = 0;
  let suspiciousRunAccuracyVariance = 0;
  let currentRunLength = 1;
  let currentRunAccuracy = isFiniteNumber(samples[0]?.accuracy) ? [samples[0].accuracy] : [];

  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const sameCoords =
      roundCoord(prev.lat) === roundCoord(curr.lat) &&
      roundCoord(prev.lng) === roundCoord(curr.lng) &&
      curr.timestamp > prev.timestamp;

    if (sameCoords) {
      currentRunLength += 1;
      if (isFiniteNumber(curr.accuracy)) currentRunAccuracy.push(curr.accuracy);
    } else {
      if (currentRunLength > longestRun) longestRun = currentRunLength;
      const runVariance = variance(currentRunAccuracy);
      if (currentRunLength >= 5 && runVariance < 1) {
        suspiciousRunLength = Math.max(suspiciousRunLength, currentRunLength);
        suspiciousRunAccuracyVariance = runVariance;
      }
      currentRunLength = 1;
      currentRunAccuracy = isFiniteNumber(curr.accuracy) ? [curr.accuracy] : [];
    }
  }

  if (currentRunLength > longestRun) longestRun = currentRunLength;
  const finalVariance = variance(currentRunAccuracy);
  if (currentRunLength >= 5 && finalVariance < 1) {
    suspiciousRunLength = Math.max(suspiciousRunLength, currentRunLength);
    suspiciousRunAccuracyVariance = finalVariance;
  }

  return {
    longestRun,
    suspiciousRunLength,
    suspiciousRunAccuracyVariance,
  };
}

function formatMeters(value) {
  return `${value.toFixed(1)} m`;
}

function formatSeconds(value) {
  return `${value.toFixed(1)} s`;
}

function collectMetrics(samples, collectionNowMs = Date.now()) {
  const pairs = [];
  let totalDistance = 0;
  let maxImpliedSpeed = 0;
  let repeatedIdenticalCoordinates = 0;
  let timestampAnomalies = 0;
  let largeJumpCount = 0;
  let speedMismatchCount = 0;
  let speedAgreementCount = 0;
  let headingWithoutMovementCount = 0;
  let fixedHeadingSpeedDuringJumpCount = 0;
  let smoothPairCount = 0;
  let validPairCount = 0;
  let oddFieldCount = 0;
  let extremelyPoorAccuracyCount = 0;
  let movementExpectationFromSpeedCount = 0;
  let movementExpectationFromHeadingCount = 0;

  const impliedSpeeds = [];
  const accuracyValues = [];
  const maxDistanceFromFirst = [];
  const first = samples[0];

  samples.forEach((sample) => {
    if (!isFiniteNumber(sample.lat) || !isFiniteNumber(sample.lng) || !isFiniteNumber(sample.timestamp)) {
      oddFieldCount += 1;
    }
    if (!isFiniteNumber(sample.accuracy) || sample.accuracy < 0) {
      oddFieldCount += 1;
    } else {
      accuracyValues.push(sample.accuracy);
      if (sample.accuracy > 1000) extremelyPoorAccuracyCount += 1;
    }

    if (sample.altitude === null || sample.altitude === undefined) oddFieldCount += 1;
    if (sample.altitudeAccuracy === null || sample.altitudeAccuracy === undefined) oddFieldCount += 1;

    if (sample.heading !== null && sample.heading !== undefined) {
      if (!isFiniteNumber(sample.heading) || sample.heading < 0 || sample.heading >= 360) oddFieldCount += 1;
      movementExpectationFromHeadingCount += 1;
    }

    if (sample.speed !== null && sample.speed !== undefined) {
      if (!isFiniteNumber(sample.speed) || sample.speed < 0) oddFieldCount += 1;
      if (isFiniteNumber(sample.speed) && sample.speed > 1) movementExpectationFromSpeedCount += 1;
    }

    if (isFiniteNumber(sample.timestamp) && collectionNowMs - sample.timestamp > 60_000) {
      timestampAnomalies += 1;
    }

    if (first) {
      maxDistanceFromFirst.push(haversineDistanceMeters(first, sample));
    }
  });

  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const timeDeltaMs = curr.timestamp - prev.timestamp;
    const distanceMeters = haversineDistanceMeters(prev, curr);
    const impliedSpeedMps = timeDeltaMs > 0 ? distanceMeters / (timeDeltaMs / 1000) : null;
    const headingChangeDegrees = headingDeltaDegrees(prev.heading, curr.heading);
    const didAccuracyImproveOrWorsen = classifyAccuracyDelta(prev.accuracy, curr.accuracy);
    const reportedSpeedMps = isFiniteNumber(curr.speed) ? curr.speed : null;

    if (roundCoord(prev.lat) === roundCoord(curr.lat) && roundCoord(prev.lng) === roundCoord(curr.lng) && timeDeltaMs > 0) {
      repeatedIdenticalCoordinates += 1;
    }

    if (timeDeltaMs <= 0) {
      timestampAnomalies += 1;
    }

    if (distanceMeters > 5000 && timeDeltaMs > 0 && timeDeltaMs < 10_000) {
      largeJumpCount += 1;
    }

    if (distanceMeters < 3 && isFiniteNumber(curr.heading)) {
      headingWithoutMovementCount += 1;
    }

    if (
      i >= 2 &&
      distanceMeters > 150 &&
      isFiniteNumber(prev.heading) &&
      isFiniteNumber(curr.heading) &&
      isFiniteNumber(prev.speed) &&
      isFiniteNumber(curr.speed) &&
      Math.abs(curr.heading - prev.heading) < 0.1 &&
      Math.abs(curr.speed - prev.speed) < 0.1
    ) {
      fixedHeadingSpeedDuringJumpCount += 1;
    }

    if (impliedSpeedMps !== null && isFiniteNumber(impliedSpeedMps)) {
      totalDistance += distanceMeters;
      impliedSpeeds.push(impliedSpeedMps);
      maxImpliedSpeed = Math.max(maxImpliedSpeed, impliedSpeedMps);

      if (
        reportedSpeedMps !== null &&
        impliedSpeedMps > 0.5 &&
        Math.abs(reportedSpeedMps - impliedSpeedMps) > Math.max(10, impliedSpeedMps * 0.7)
      ) {
        speedMismatchCount += 1;
      }

      if (
        reportedSpeedMps !== null &&
        impliedSpeedMps > 0.5 &&
        Math.abs(reportedSpeedMps - impliedSpeedMps) <= Math.max(3, impliedSpeedMps * 0.35)
      ) {
        speedAgreementCount += 1;
      }
    }

    if (timeDeltaMs > 0) {
      validPairCount += 1;
      if ((impliedSpeedMps === null || impliedSpeedMps <= 20) && distanceMeters < 300 && (headingChangeDegrees === null || headingChangeDegrees < 70)) {
        smoothPairCount += 1;
      }
    }

    pairs.push({
      index: i,
      timeDeltaMs,
      distanceMeters,
      jumpDistanceMeters: distanceMeters,
      impliedSpeedMps,
      headingChangeDegrees,
      didAccuracyImproveOrWorsen,
      reportedSpeedMps,
      prevTimestamp: prev.timestamp,
      currTimestamp: curr.timestamp,
    });
  }

  const identicalRuns = summarizeIdenticalCoordinateRuns(samples);
  const elapsedMs =
    samples.length >= 2 && isFiniteNumber(samples[0].timestamp) && isFiniteNumber(samples[samples.length - 1].timestamp)
      ? samples[samples.length - 1].timestamp - samples[0].timestamp
      : 0;
  const coordinateSpreadMeters = maxDistanceFromFirst.length ? Math.max(...maxDistanceFromFirst) : 0;

  return {
    pairs,
    elapsedMs,
    totalDistance,
    maxImpliedSpeed,
    averageImpliedSpeed: mean(impliedSpeeds),
    largeJumpCount,
    repeatedIdenticalCoordinates,
    timestampAnomalies,
    accuracyVariance: variance(accuracyValues),
    oddFieldCount,
    extremelyPoorAccuracyCount,
    impliedSpeeds,
    validPairCount,
    smoothPairCount,
    speedMismatchCount,
    speedAgreementCount,
    headingWithoutMovementCount,
    fixedHeadingSpeedDuringJumpCount,
    movementExpectationFromSpeedCount,
    movementExpectationFromHeadingCount,
    coordinateSpreadMeters,
    identicalRuns,
  };
}

export function classifyRisk(score) {
  if (score <= 24) return "Probably normal";
  if (score <= 49) return "Low confidence / mild anomalies";
  if (score <= 74) return "Suspicious";
  return "Likely spoofed";
}

export function scoreRules(metrics) {
  let score = 0;
  const reasons = [];

  const impossibleSpeedPair = metrics.pairs.find(
    (pair) =>
      pair.timeDeltaMs > 0 &&
      pair.timeDeltaMs < 15_000 &&
      isFiniteNumber(pair.impliedSpeedMps) &&
      pair.impliedSpeedMps > 100 &&
      (!isFiniteNumber(pair.reportedSpeedMps) || pair.reportedSpeedMps < pair.impliedSpeedMps * 0.5),
  );

  if (impossibleSpeedPair) {
    score += 40;
    reasons.push(
      `Implied speed reached ${impossibleSpeedPair.impliedSpeedMps.toFixed(1)} m/s without matching device speed metadata.`,
    );
  }

  if (metrics.largeJumpCount > 0) {
    const firstJump = metrics.pairs.find((pair) => pair.distanceMeters > 5000 && pair.timeDeltaMs > 0 && pair.timeDeltaMs < 10_000);
    score += 25;
    if (firstJump) {
      reasons.push(`Location jumped ${formatMeters(firstJump.distanceMeters)} in ${formatSeconds(firstJump.timeDeltaMs / 1000)}.`);
    } else {
      reasons.push("Large location jump detected over a short interval.");
    }
  }

  if (metrics.largeJumpCount > 1) {
    score += 15;
    reasons.push(`Multiple large jumps were observed in one session (${metrics.largeJumpCount} jumps).`);
  }

  if (metrics.identicalRuns.suspiciousRunLength >= 5) {
    score += 20;
    reasons.push(
      `${metrics.identicalRuns.suspiciousRunLength} consecutive samples were identical down to 7 decimals with nearly constant accuracy.`,
    );
  }

  if (metrics.fixedHeadingSpeedDuringJumpCount >= 2) {
    score += 10;
    reasons.push("Speed and heading stayed almost fixed while coordinates jumped, which looks synthetic.");
  }

  if (
    metrics.coordinateSpreadMeters < 5 &&
    (metrics.movementExpectationFromSpeedCount >= 3 || metrics.movementExpectationFromHeadingCount >= 4)
  ) {
    score += 10;
    reasons.push("Movement metadata suggests motion, but coordinates stayed almost perfectly centered.");
  }

  if (metrics.speedMismatchCount >= 2) {
    score += 15;
    reasons.push("Reported speed differs strongly from speed implied by coordinate changes.");
  }

  if (metrics.headingWithoutMovementCount >= 3) {
    score += 10;
    reasons.push("Heading was repeatedly present while computed movement was near zero.");
  }

  if (metrics.timestampAnomalies >= 2) {
    score += 10;
    reasons.push(`Timestamp anomalies detected (${metrics.timestampAnomalies} stale, duplicated, or non-monotonic values).`);
  }

  if (metrics.extremelyPoorAccuracyCount > 0) {
    score += 5;
    reasons.push("Accuracy was very poor (>1000 m) for part of the session, so confidence is low.");
  }

  if (metrics.validPairCount >= 3 && metrics.smoothPairCount / metrics.validPairCount >= 0.7 && metrics.largeJumpCount === 0) {
    score -= 10;
    reasons.push("Benign indicator: readings evolved smoothly over time.");
  }

  if (metrics.speedAgreementCount >= 2 && metrics.speedMismatchCount === 0) {
    score -= 10;
    reasons.push("Benign indicator: implied speed and reported speed mostly agreed.");
  }

  if (
    metrics.accuracyVariance >= 4 &&
    metrics.accuracyVariance <= 50_000 &&
    metrics.coordinateSpreadMeters >= 8 &&
    metrics.repeatedIdenticalCoordinates < 3
  ) {
    score -= 10;
    reasons.push("Benign indicator: accuracy varied naturally while coordinates drifted realistically.");
  }

  return {
    score: clamp(Math.round(score), 0, 100),
    reasons,
    label: classifyRisk(clamp(Math.round(score), 0, 100)),
  };
}

export function analyzeSession(samples, options = {}) {
  const collectionNowMs = options.collectionNowMs ?? Date.now();
  const metrics = collectMetrics(samples, collectionNowMs);
  const enoughSamples = samples.length >= MIN_SAMPLES;
  const enoughDuration = metrics.elapsedMs >= MIN_DURATION_MS;
  const ready = enoughSamples && enoughDuration;

  if (!ready) {
    const reasons = [
      `Not enough data yet: collected ${samples.length} sample(s) over ${(metrics.elapsedMs / 1000).toFixed(1)}s.`,
      `Need at least ${MIN_SAMPLES} samples across ${(MIN_DURATION_MS / 1000).toFixed(0)}+ seconds for minimum viable analysis.`,
    ];
    return {
      metrics,
      risk: {
        score: 0,
        label: "Not enough data",
        reasons,
        ready: false,
      },
    };
  }

  const scored = scoreRules(metrics);
  return {
    metrics,
    risk: {
      ...scored,
      ready: true,
    },
  };
}

function createSample(lat, lng, accuracy, timestamp, extras = {}) {
  return {
    lat,
    lng,
    accuracy,
    altitude: extras.altitude ?? null,
    altitudeAccuracy: extras.altitudeAccuracy ?? null,
    heading: extras.heading ?? null,
    speed: extras.speed ?? null,
    timestamp,
  };
}

export function buildMockCases() {
  const t0 = 1_900_000_000_000;

  const normalWalkingPath = [
    createSample(37.7749, -122.4194, 12, t0, { speed: 1.2, heading: 68 }),
    createSample(37.7750, -122.4193, 10, t0 + 5000, { speed: 1.5, heading: 70 }),
    createSample(37.7751, -122.4192, 9, t0 + 10_000, { speed: 1.3, heading: 66 }),
    createSample(37.77519, -122.41911, 11, t0 + 15_000, { speed: 1.6, heading: 72 }),
    createSample(37.77528, -122.41901, 13, t0 + 20_000, { speed: 1.4, heading: 71 }),
    createSample(37.77538, -122.41891, 10, t0 + 25_000, { speed: 1.5, heading: 69 }),
  ];

  const normalStationary = [
    createSample(40.712776, -74.005974, 7, t0, { speed: 0, heading: null }),
    createSample(40.712778, -74.005972, 8, t0 + 5000, { speed: 0, heading: null }),
    createSample(40.712775, -74.00597, 9, t0 + 10_000, { speed: 0, heading: null }),
    createSample(40.712777, -74.005973, 8, t0 + 15_000, { speed: 0, heading: null }),
    createSample(40.712776, -74.005971, 7, t0 + 20_000, { speed: 0, heading: null }),
    createSample(40.712775, -74.005972, 9, t0 + 25_000, { speed: 0, heading: null }),
  ];

  const teleportPath = [
    createSample(34.052235, -118.243683, 12, t0, { speed: 0.6, heading: 45 }),
    createSample(34.05225, -118.24367, 11, t0 + 4000, { speed: 0.7, heading: 46 }),
    createSample(34.1031, -118.3267, 10, t0 + 8000, { speed: 0.8, heading: 47 }),
    createSample(34.2032, -118.4501, 11, t0 + 12_000, { speed: 0.5, heading: 47 }),
    createSample(34.2105, -118.4602, 12, t0 + 16_000, { speed: 0.6, heading: 47 }),
    createSample(34.3105, -118.6602, 13, t0 + 20_000, { speed: 0.5, heading: 47 }),
  ];

  const constantIdenticalPath = [
    createSample(51.5073512, -0.1277583, 5, t0, { speed: 0, heading: 120 }),
    createSample(51.5073512, -0.1277583, 5, t0 + 4000, { speed: 0, heading: 120 }),
    createSample(51.5073512, -0.1277583, 5, t0 + 8000, { speed: 0, heading: 120 }),
    createSample(51.5073512, -0.1277583, 5, t0 + 12_000, { speed: 0, heading: 120 }),
    createSample(51.5073512, -0.1277583, 5, t0 + 16_000, { speed: 0, heading: 120 }),
    createSample(51.5073512, -0.1277583, 5, t0 + 20_000, { speed: 0, heading: 120 }),
  ];

  const highAccuracyInconsistentMetadata = [
    createSample(48.856613, 2.352222, 3, t0, { speed: 0.1, heading: 90 }),
    createSample(48.856915, 2.354001, 3, t0 + 4000, { speed: 0.1, heading: 90 }),
    createSample(48.85731, 2.358004, 3, t0 + 8000, { speed: 0.1, heading: 90 }),
    createSample(48.85661, 2.35222, 3, t0 + 12_000, { speed: 0.1, heading: 90 }),
    createSample(48.85775, 2.3622, 3, t0 + 16_000, { speed: 0.1, heading: 90 }),
    createSample(48.856613, 2.352222, 3, t0 + 20_000, { speed: 0.1, heading: 90 }),
  ];

  return [
    { id: "normal-walking", name: "Normal walking path", samples: normalWalkingPath },
    { id: "normal-stationary", name: "Normal stationary user", samples: normalStationary },
    { id: "teleport-jumps", name: "Teleport / jump path", samples: teleportPath },
    { id: "identical-fake", name: "Constant identical fake-looking path", samples: constantIdenticalPath },
    {
      id: "metadata-inconsistent",
      name: "High-accuracy but inconsistent metadata",
      samples: highAccuracyInconsistentMetadata,
    },
  ];
}

export function runMockAnalyses() {
  return buildMockCases().map((scenario) => {
    const lastTimestamp = scenario.samples[scenario.samples.length - 1]?.timestamp ?? Date.now();
    const result = analyzeSession(scenario.samples, { collectionNowMs: lastTimestamp + 1000 });
    return {
      id: scenario.id,
      name: scenario.name,
      ...result,
    };
  });
}

export const ANALYSIS_THRESHOLDS = {
  minSamples: MIN_SAMPLES,
  minDurationMs: MIN_DURATION_MS,
};
