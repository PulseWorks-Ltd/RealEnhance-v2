const fs = require('fs');
const path = require('path');

const ROOT = '/workspaces/RealEnhance-v2';
const TMP_DIR = path.join(ROOT, 'tmp');
const OUT_DIR = path.join(ROOT, 'worker', 'reports', 'validator-review');

const REQUIRED_COLUMNS = [
  'jobId',
  'imageId',
  'batchId',
  'roomType',
  'attempt',
  'finalStatus',
  'originalImageSignedUrl',
  'stage1ImageSignedUrl',
  'stage2ImageSignedUrl',
  'openingStatus',
  'openingHardFail',
  'openingConfidence',
  'openingReason',
  'openingDeterministicHardFailIssue',
  'envelopeStatus',
  'envelopeHardFail',
  'envelopeConfidence',
  'envelopeReason',
  'flooringStatus',
  'flooringHardFail',
  'flooringConfidence',
  'flooringReason',
  'fixtureStatus',
  'fixtureHardFail',
  'fixtureConfidence',
  'fixtureReason',
  'unifiedStatus',
  'unifiedScore',
  'unifiedPassed',
  'published',
  'retryCount',
  'openingStructuralSignalCount',
  'envelopeStructuralSignalCount',
  'flooringStructuralSignalCount',
  'fixtureStructuralSignalCount',
];

const CONF_BANDS = [
  [0.0, 0.30],
  [0.30, 0.50],
  [0.50, 0.70],
  [0.70, 0.80],
  [0.80, 0.90],
  [0.90, 1.0000001],
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function findLatestBatchFiles() {
  const files = fs.readdirSync(TMP_DIR)
    .filter((f) => /^kaipuke-stage2-validators-\d+\.json$/.test(f))
    .sort((a, b) => {
      const ta = Number(a.match(/(\d+)\.json$/)?.[1] || 0);
      const tb = Number(b.match(/(\d+)\.json$/)?.[1] || 0);
      return tb - ta;
    })
    .slice(0, 2)
    .map((f) => path.join(TMP_DIR, f));

  if (files.length < 2) {
    throw new Error('Expected at least two kaipuke-stage2-validators-*.json files in tmp/.');
  }

  return files;
}

function toBool(v) {
  return v === true;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getSpecialistByValidator(row, name) {
  const specialist = row.specialist || {};
  if (name === 'opening') return specialist.opening || null;
  if (name === 'envelope') return specialist.envelope || null;
  if (name === 'flooring') return specialist.floor || null;
  if (name === 'fixture') return specialist.fixture || null;
  return null;
}

function countStructuralSignals(row, name) {
  const specSignals = row.specialistSignals;
  if (Array.isArray(specSignals)) {
    const m = specSignals.find((s) => {
      if (!s || typeof s !== 'object') return false;
      if (name === 'opening') return s.validator === 'openings';
      if (name === 'envelope') return s.validator === 'envelope';
      if (name === 'flooring') return s.validator === 'floor';
      if (name === 'fixture') return s.validator === 'fixtures';
      return false;
    });
    if (m && Array.isArray(m.structuralSignals)) return m.structuralSignals.length;
  }
  return 0;
}

function normalizeFinalStatus(v) {
  if (!v) return 'unknown';
  const s = String(v).toLowerCase();
  if (s === 'pass' || s === 'published') return 'pass';
  if (s === 'fail' || s === 'blocked') return 'fail';
  return s;
}

function buildRowsFromBatch(filePath, batchIndex) {
  const json = readJson(filePath);
  const rows = Array.isArray(json.rows) ? json.rows : [];
  const batchId = path.basename(filePath, '.json');

  return rows.map((row, idx) => {
    const opening = getSpecialistByValidator(row, 'opening') || {};
    const envelope = getSpecialistByValidator(row, 'envelope') || {};
    const flooring = getSpecialistByValidator(row, 'flooring') || {};
    const fixture = getSpecialistByValidator(row, 'fixture') || {};
    const unified = row.unified || {};

    // These artifacts do not include production job/image ids or signed urls.
    const imageLocalId = String(row.id || idx + 1).padStart(2, '0');

    return {
      jobId: `unknown_job_${batchId}_${imageLocalId}`,
      imageId: `unknown_image_${batchId}_${imageLocalId}`,
      batchId,
      roomType: 'unknown',
      attempt: 1,
      finalStatus: normalizeFinalStatus(row.finalDecision),

      originalImageSignedUrl: '',
      stage1ImageSignedUrl: '',
      stage2ImageSignedUrl: '',

      openingStatus: opening.status || (opening.pass === false ? 'fail' : 'pass'),
      openingHardFail: toBool(opening.hardFail),
      openingConfidence: toNum(opening.confidence),
      openingReason: opening.reason || '',
      openingDeterministicHardFailIssue: toBool(opening.deterministicHardFailIssue),

      envelopeStatus: envelope.status || (envelope.pass === false ? 'fail' : 'pass'),
      envelopeHardFail: toBool(envelope.hardFail),
      envelopeConfidence: toNum(envelope.confidence),
      envelopeReason: envelope.reason || '',

      flooringStatus: flooring.status || (flooring.pass === false ? 'fail' : 'pass'),
      flooringHardFail: toBool(flooring.hardFail),
      flooringConfidence: toNum(flooring.confidence),
      flooringReason: flooring.reason || '',

      fixtureStatus: fixture.status || (fixture.pass === false ? 'fail' : 'pass'),
      fixtureHardFail: toBool(fixture.hardFail),
      fixtureConfidence: toNum(fixture.confidence),
      fixtureReason: fixture.reason || '',

      unifiedStatus: unified.pass === false ? 'fail' : 'pass',
      unifiedScore: toNum(unified.elapsedMs) === null ? null : null,
      unifiedPassed: toBool(unified.pass),

      published: normalizeFinalStatus(row.finalDecision) === 'pass',
      retryCount: 0,

      openingStructuralSignalCount: countStructuralSignals(row, 'opening'),
      envelopeStructuralSignalCount: countStructuralSignals(row, 'envelope'),
      flooringStructuralSignalCount: countStructuralSignals(row, 'flooring'),
      fixtureStructuralSignalCount: countStructuralSignals(row, 'fixture'),

      _sourceFile: filePath,
      _sourceRowIndex: idx,
      _batchOrdinal: batchIndex + 1,
      _baselineImageName: row.baseline || '',
      _enhancedImageName: row.enhanced || '',
      _finalDecisionRaw: row.finalDecision || '',
      _unifiedIssueType: unified.issueType || '',
      _unifiedIssueTier: unified.issueTier || '',
      _unifiedReason: unified.reason || '',
    };
  });
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function bandLabel(min, max, isLast) {
  if (isLast) return '0.90-1.00';
  return `${min.toFixed(2)}-${max.toFixed(2)}`;
}

function bucketConfidence(value) {
  if (!Number.isFinite(value)) return null;
  for (let i = 0; i < CONF_BANDS.length; i++) {
    const [min, max] = CONF_BANDS[i];
    const includeUpper = i === CONF_BANDS.length - 1;
    if (value >= min && (includeUpper ? value <= max : value < max)) {
      return bandLabel(min, max, includeUpper);
    }
  }
  return null;
}

function buildConfidenceDistribution(rows, validatorPrefix) {
  const key = `${validatorPrefix}Confidence`;
  const counts = {};
  for (let i = 0; i < CONF_BANDS.length; i++) {
    const [min, max] = CONF_BANDS[i];
    counts[bandLabel(min, max, i === CONF_BANDS.length - 1)] = 0;
  }

  for (const row of rows) {
    const b = bucketConfidence(row[key]);
    if (b) counts[b] += 1;
  }
  return counts;
}

function thresholdSimulation(rows, validatorPrefix, currentThreshold) {
  const confKey = `${validatorPrefix}Confidence`;
  const hardFailKey = `${validatorPrefix}HardFail`;

  const currentSet = new Set(
    rows
      .filter((r) => Number.isFinite(r[confKey]) && r[confKey] >= currentThreshold)
      .map((r) => `${r.jobId}::${r.imageId}`)
  );

  const thresholds = [0.85, 0.80, 0.75];
  const out = {
    currentThreshold,
    currentHardFailCountByConfidenceRule: currentSet.size,
    alternatives: {},
  };

  for (const t of thresholds) {
    const altSet = new Set(
      rows
        .filter((r) => Number.isFinite(r[confKey]) && r[confKey] >= t)
        .map((r) => `${r.jobId}::${r.imageId}`)
    );

    let additional = 0;
    for (const id of altSet) {
      if (!currentSet.has(id)) additional += 1;
    }

    out.alternatives[t.toFixed(2)] = {
      simulatedHardFailCountByConfidenceRule: altSet.size,
      additionalImagesThatWouldHardFail: additional,
      note: 'Simulation uses confidence-only thresholding over collected rows; no code/threshold changes applied.',
    };
  }

  out.actualHardFailFlagCount = rows.filter((r) => r[hardFailKey] === true).length;
  return out;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const batchFiles = findLatestBatchFiles();
  const datasetRows = batchFiles.flatMap((f, i) => buildRowsFromBatch(f, i));

  // Primary CSV and JSON
  const csvPath = path.join(OUT_DIR, 'specialist_validator_review_dataset.csv');
  const jsonPath = path.join(OUT_DIR, 'specialist_validator_review_dataset.json');

  writeCsv(csvPath, datasetRows, REQUIRED_COLUMNS);
  fs.writeFileSync(jsonPath, JSON.stringify(datasetRows, null, 2), 'utf8');

  // Escaped failures: specialist status fail AND published=true
  const escaped = [];
  for (const r of datasetRows) {
    const published = r.published === true;
    if (!published) continue;

    const checks = [
      { validator: 'opening', status: r.openingStatus, confidence: r.openingConfidence, hardFail: r.openingHardFail, reason: r.openingReason },
      { validator: 'envelope', status: r.envelopeStatus, confidence: r.envelopeConfidence, hardFail: r.envelopeHardFail, reason: r.envelopeReason },
      { validator: 'flooring', status: r.flooringStatus, confidence: r.flooringConfidence, hardFail: r.flooringHardFail, reason: r.flooringReason },
      { validator: 'fixture', status: r.fixtureStatus, confidence: r.fixtureConfidence, hardFail: r.fixtureHardFail, reason: r.fixtureReason },
    ];

    for (const c of checks) {
      if (String(c.status).toLowerCase() === 'fail') {
        escaped.push({
          jobId: r.jobId,
          imageId: r.imageId,
          validator: c.validator,
          confidence: c.confidence,
          hardFail: c.hardFail,
          reason: c.reason,
          stage2ImageSignedUrl: r.stage2ImageSignedUrl,
        });
      }
    }
  }

  const escapedCsv = path.join(OUT_DIR, 'escaped_failures_published.csv');
  const escapedJson = path.join(OUT_DIR, 'escaped_failures_published.json');
  writeCsv(escapedCsv, escaped, ['jobId', 'imageId', 'validator', 'confidence', 'hardFail', 'reason', 'stage2ImageSignedUrl']);
  fs.writeFileSync(escapedJson, JSON.stringify(escaped, null, 2), 'utf8');

  // Confidence distributions
  const confidenceDistribution = {
    opening: buildConfidenceDistribution(datasetRows, 'opening'),
    envelope: buildConfidenceDistribution(datasetRows, 'envelope'),
    flooring: buildConfidenceDistribution(datasetRows, 'flooring'),
    fixture: buildConfidenceDistribution(datasetRows, 'fixture'),
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'confidence_distribution_report.json'),
    JSON.stringify(confidenceDistribution, null, 2),
    'utf8'
  );

  // Threshold simulation
  const thresholdSimulationReport = {
    opening: thresholdSimulation(datasetRows, 'opening', 0.90),
    envelope: thresholdSimulation(datasetRows, 'envelope', 1.00),
    flooring: thresholdSimulation(datasetRows, 'flooring', 0.90),
    fixture: thresholdSimulation(datasetRows, 'fixture', 0.90),
  };

  fs.writeFileSync(
    path.join(OUT_DIR, 'threshold_simulation_report.json'),
    JSON.stringify(thresholdSimulationReport, null, 2),
    'utf8'
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    sourceBatchFiles: batchFiles,
    rowCount: datasetRows.length,
    escapedFailureCount: escaped.length,
    notes: [
      'No code or threshold behavior was modified.',
      'Latest two available batch artifacts in tmp/ were used: kaipuke-stage2-validators-*.json.',
      'These artifacts do not include production jobId/imageId/signed URL fields, so those columns are emitted empty or synthetic placeholders for review traceability.',
      'If you provide additional production artifacts containing job/image/url mappings for these same batches, this script can be rerun to enrich those columns directly.',
    ],
  };

  fs.writeFileSync(path.join(OUT_DIR, 'review_package_summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('Wrote review package to', OUT_DIR);
  console.log('Rows:', datasetRows.length, 'Escaped:', escaped.length);
}

main();
