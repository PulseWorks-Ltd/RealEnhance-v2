const fs = require('fs');
const path = require('path');

const OUT_DIR = path.resolve(__dirname);
const ROOT = path.resolve(__dirname, '../../..');

const LOG_PATH = path.join(ROOT, 'logs.1779875931772.json');
const SECOND_BATCH_PATH = path.join(ROOT, 'tmp/kaipuke-stage2-validators-1774360443942.json');

const BANDS = [
  [0.0, 0.3],
  [0.3, 0.5],
  [0.5, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1.0],
];

function safeReadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseScalar(raw) {
  const v = raw.trim().replace(/,$/, '');
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseObjectBlock(lines, startIdx) {
  const out = {};
  let endIdx = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const msg = String(lines[i].message || '').trim();
    endIdx = i;
    if (msg === '}') break;
    const kv = msg.match(/^([a-zA-Z0-9_]+):\s*(.+)$/);
    if (kv) out[kv[1]] = parseScalar(kv[2]);
  }
  return { out, endIdx };
}

function findNear(lines, idx, regex, radius = 35) {
  let best = null;
  let bestDist = Infinity;
  for (let i = Math.max(0, idx - radius); i <= Math.min(lines.length - 1, idx + radius); i++) {
    const m = String(lines[i].message || '').match(regex);
    if (!m) continue;
    const d = Math.abs(i - idx);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best;
}

function ensureJob(map, jobId) {
  if (!jobId) return null;
  if (!map[jobId]) {
    map[jobId] = {
      source: 'logs.1779875931772.json',
      batchId: null,
      jobId,
      imageId: null,
      roomType: null,
      attempt: null,
      finalStatus: null,
      originalImageSignedUrl: null,
      stage1ImageSignedUrl: null,
      stage2ImageSignedUrl: null,
      opening: {},
      envelope: {},
      floor: {},
      fixture: {},
      unifiedStatus: null,
      unifiedScore: null,
      unifiedPassed: null,
      published: false,
      retryCount: 0,
      _outputs: new Set(),
      _attempts: new Set(),
    };
  }
  return map[jobId];
}

function parseProductionLogBatch() {
  const lines = safeReadJson(LOG_PATH);
  const jobs = {};
  const JOB_ID_RE = /(job_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  const allBatchIds = new Set();
  for (const line of lines) {
    const msg = String(line.message || '');
    for (const m of msg.matchAll(/client-batch-[a-zA-Z0-9-]+/g)) {
      allBatchIds.add(m[0]);
    }
  }
  const batchId = [...allBatchIds].sort().slice(-1)[0] || 'unknown_batch';

  for (let i = 0; i < lines.length; i++) {
    const msg = String(lines[i].message || '');

    const model = msg.match(/\[MODEL\]\[2\].*job=(job_[a-zA-Z0-9-]+).*room=([a-zA-Z_]+)/);
    if (model) {
      const row = ensureJob(jobs, model[1]);
      if (row) row.roomType = model[2];
    }

    const verdict = msg.match(/\[validator\]\s+verdict=(PASS|FAIL)\s+score=([0-9.]+)\s+jobId=(job_[a-zA-Z0-9-]+)/);
    if (verdict) {
      const row = ensureJob(jobs, verdict[3]);
      if (row) {
        row.unifiedStatus = verdict[1];
        row.unifiedPassed = verdict[1] === 'PASS';
        row.unifiedScore = Number(verdict[2]);
      }
    }

    const jobFinal = msg.match(/\[JOB_FINAL\]\[job=(job_[a-zA-Z0-9-]+)\]\s+status=([a-zA-Z_]+)\s+hardFail=(true|false)/);
    if (jobFinal) {
      const row = ensureJob(jobs, jobFinal[1]);
      if (row) row.finalStatus = jobFinal[2];
    }

    const published = msg.match(/\[worker\]\s+✅ Stage 2 published:\s+(https?:\/\/\S+job_[a-zA-Z0-9-]+\S*)/);
    if (published) {
      const j = published[1].match(JOB_ID_RE);
      if (j) {
        const row = ensureJob(jobs, j[1]);
        if (row) {
          row.published = true;
          row.stage2ImageSignedUrl = published[1];
          row._outputs.add(published[1]);
        }
      }
    }

    const jobLine = msg.match(/^JOB\s+(job_[a-zA-Z0-9-]+)/);
    if (jobLine) {
      const row = ensureJob(jobs, jobLine[1]);
      if (row) row.batchId = batchId;
    }

    const upload = msg.match(/^upload=(https?:\/\/\S+job_[a-zA-Z0-9-]+\S*)/);
    if (upload) {
      const j = upload[1].match(JOB_ID_RE);
      if (j) {
        const row = ensureJob(jobs, j[1]);
        if (row) row.originalImageSignedUrl = upload[1];
      }
    }

    const output = msg.match(/^output=(https?:\/\/\S+job_[a-zA-Z0-9-]+\S*)/);
    if (output) {
      const j = output[1].match(JOB_ID_RE);
      if (j) {
        const row = ensureJob(jobs, j[1]);
        if (row) {
          row.stage2ImageSignedUrl = output[1];
          row._outputs.add(output[1]);
        }
      }
    }

    const imageLine = msg.match(/^image=(img_[a-zA-Z0-9-]+)/);
    if (imageLine) {
      const nearJob = findNear(lines, i, /JOB\s+(job_[a-zA-Z0-9-]+)/, 10);
      if (nearJob) {
        const row = ensureJob(jobs, nearJob[1]);
        if (row) row.imageId = imageLine[1];
      }
    }

    const stage1A = msg.match(/^stage1A=(https?:\/\/\S+)/);
    if (stage1A) {
      const nearJob = findNear(lines, i, /JOB\s+(job_[a-zA-Z0-9-]+)/, 10);
      if (nearJob) {
        const row = ensureJob(jobs, nearJob[1]);
        if (row) row.stage1ImageSignedUrl = stage1A[1];
      }
    }

    const blockHeader = msg.match(/^\[SPECIALIST_REVIEW\]\[(OPENING|ENVELOPE|FLOOR|FIXTURE)\]\s*\{$/);
    if (blockHeader) {
      const { out, endIdx } = parseObjectBlock(lines, i);
      i = endIdx;
      const nearJob = out.jobId || (findNear(lines, i, /jobId:\s*'(job_[a-zA-Z0-9-]+)'/) || [])[1] || (findNear(lines, i, /job_id=(job_[a-zA-Z0-9-]+)/) || [])[1] || (findNear(lines, i, /JOB\s+(job_[a-zA-Z0-9-]+)/) || [])[1];
      const nearImage = out.imageId || (findNear(lines, i, /imageId:\s*'(img_[a-zA-Z0-9-]+)'/) || [])[1] || (findNear(lines, i, /image_id=(img_[a-zA-Z0-9-]+)/) || [])[1];
      const row = ensureJob(jobs, nearJob);
      if (!row) continue;
      if (nearImage && !row.imageId) row.imageId = nearImage;
      if (out.attempt != null) row._attempts.add(Number(out.attempt));

      const target = blockHeader[1] === 'OPENING'
        ? row.opening
        : blockHeader[1] === 'ENVELOPE'
          ? row.envelope
          : blockHeader[1] === 'FLOOR'
            ? row.floor
            : row.fixture;

      target.status = out.pass === true ? 'pass' : (out.pass === false ? 'fail' : target.status || null);
      if (out.hardFail !== undefined) target.hardFail = out.hardFail;
      if (out.confidence !== undefined) target.confidence = Number(out.confidence);
      if (out.reason !== undefined) target.reason = String(out.reason);
      if (out.structuralSignalCount !== undefined) target.structuralSignalCount = Number(out.structuralSignalCount);
      if (blockHeader[1] === 'OPENING' && out.deterministicHardFailIssue !== undefined) {
        target.deterministicHardFailIssue = out.deterministicHardFailIssue;
      }
    }

    const classHeader = msg.match(/^\[SPECIALIST_CLASSIFICATION\]\s*\{$/);
    if (classHeader) {
      const { out, endIdx } = parseObjectBlock(lines, i);
      i = endIdx;
      const jobId = out.jobId || (findNear(lines, i, /jobId:\s*'(job_[a-zA-Z0-9-]+)'/) || [])[1] || (findNear(lines, i, /job_id=(job_[a-zA-Z0-9-]+)/) || [])[1];
      const row = ensureJob(jobs, jobId);
      if (!row) continue;
      if (out.imageId && !row.imageId) row.imageId = String(out.imageId);
      if (out.attempt != null) row._attempts.add(Number(out.attempt));
      const v = String(out.validator || '').toLowerCase();
      const target = v.includes('opening') ? row.opening : v.includes('envelope') ? row.envelope : v.includes('floor') ? row.floor : v.includes('fixture') ? row.fixture : null;
      if (target) {
        if (out.pass !== undefined) target.status = out.pass ? 'pass' : 'fail';
        if (out.confidence !== undefined) target.confidence = Number(out.confidence);
      }
    }
  }

  const rows = Object.values(jobs)
    .map((row) => {
      row.batchId = row.batchId || batchId;
      if (row._attempts.size > 0) row.attempt = Math.max(...row._attempts);
      if (row.attempt == null) row.attempt = 1;

      let retryCount = 0;
      for (const u of row._outputs) {
        const m = String(u).match(/-retry(\d+)/);
        if (m) retryCount = Math.max(retryCount, Number(m[1]));
      }
      row.retryCount = retryCount;

      row.opening.hardFail = row.opening.hardFail ?? false;
      row.envelope.hardFail = row.envelope.hardFail ?? false;
      row.floor.hardFail = row.floor.hardFail ?? false;
      row.fixture.hardFail = row.fixture.hardFail ?? false;

      if (!row.finalStatus) row.finalStatus = row.published ? 'complete' : 'unknown';
      if (row.unifiedPassed == null && row.finalStatus === 'complete') row.unifiedPassed = true;
      if (!row.unifiedStatus && row.unifiedPassed != null) row.unifiedStatus = row.unifiedPassed ? 'PASS' : 'FAIL';

      delete row._outputs;
      delete row._attempts;
      return row;
    })
    .filter((r) => r.jobId);

  return { batchId, rows };
}

function parseSecondBatch() {
  const src = safeReadJson(SECOND_BATCH_PATH);
  const batchId = path.basename(SECOND_BATCH_PATH, '.json');

  const rows = (src.rows || []).map((r) => {
    const opening = r.specialist?.opening || {};
    const envelope = r.specialist?.envelope || {};
    const floor = r.specialist?.floor || {};
    const fixture = r.specialist?.fixture || {};

    return {
      source: path.basename(SECOND_BATCH_PATH),
      batchId,
      jobId: `kaipuke_${batchId}_${r.id}`,
      imageId: `kaipuke_img_${r.id}`,
      roomType: 'unknown',
      attempt: 1,
      finalStatus: r.finalDecision || null,
      originalImageSignedUrl: null,
      stage1ImageSignedUrl: null,
      stage2ImageSignedUrl: null,
      opening: {
        status: opening.status ?? (opening.pass === false ? 'fail' : 'pass'),
        hardFail: opening.hardFail ?? false,
        confidence: opening.confidence ?? null,
        reason: opening.reason ?? null,
        deterministicHardFailIssue: null,
        structuralSignalCount: null,
      },
      envelope: {
        status: envelope.status ?? (envelope.pass === false ? 'fail' : 'pass'),
        hardFail: envelope.hardFail ?? false,
        confidence: envelope.confidence ?? null,
        reason: envelope.reason ?? null,
        structuralSignalCount: null,
      },
      floor: {
        status: floor.status ?? (floor.pass === false ? 'fail' : 'pass'),
        hardFail: floor.hardFail ?? false,
        confidence: floor.confidence ?? null,
        reason: floor.reason ?? null,
        structuralSignalCount: null,
      },
      fixture: {
        status: fixture.status ?? (fixture.pass === false ? 'fail' : 'pass'),
        hardFail: fixture.hardFail ?? false,
        confidence: fixture.confidence ?? null,
        reason: fixture.reason ?? null,
        structuralSignalCount: null,
      },
      unifiedStatus: r.unified?.pass === true ? 'PASS' : r.unified?.pass === false ? 'FAIL' : null,
      unifiedScore: r.unified?.score ?? null,
      unifiedPassed: r.unified?.pass ?? null,
      published: r.finalDecision === 'pass',
      retryCount: 0,
    };
  });

  return { batchId, rows };
}

function flattenRow(r) {
  return {
    jobId: r.jobId,
    imageId: r.imageId,
    batchId: r.batchId,
    roomType: r.roomType,
    attempt: r.attempt,
    finalStatus: r.finalStatus,

    originalImageSignedUrl: r.originalImageSignedUrl,
    stage1ImageSignedUrl: r.stage1ImageSignedUrl,
    stage2ImageSignedUrl: r.stage2ImageSignedUrl,

    openingStatus: r.opening.status ?? null,
    openingHardFail: r.opening.hardFail ?? null,
    openingConfidence: r.opening.confidence ?? null,
    openingReason: r.opening.reason ?? null,
    openingDeterministicHardFailIssue: r.opening.deterministicHardFailIssue ?? null,
    openingStructuralSignalCount: r.opening.structuralSignalCount ?? null,

    envelopeStatus: r.envelope.status ?? null,
    envelopeHardFail: r.envelope.hardFail ?? null,
    envelopeConfidence: r.envelope.confidence ?? null,
    envelopeReason: r.envelope.reason ?? null,
    envelopeStructuralSignalCount: r.envelope.structuralSignalCount ?? null,

    flooringStatus: r.floor.status ?? null,
    flooringHardFail: r.floor.hardFail ?? null,
    flooringConfidence: r.floor.confidence ?? null,
    flooringReason: r.floor.reason ?? null,
    flooringStructuralSignalCount: r.floor.structuralSignalCount ?? null,

    fixtureStatus: r.fixture.status ?? null,
    fixtureHardFail: r.fixture.hardFail ?? null,
    fixtureConfidence: r.fixture.confidence ?? null,
    fixtureReason: r.fixture.reason ?? null,
    fixtureStructuralSignalCount: r.fixture.structuralSignalCount ?? null,

    unifiedStatus: r.unifiedStatus,
    unifiedScore: r.unifiedScore,
    unifiedPassed: r.unifiedPassed,

    published: r.published,
    retryCount: r.retryCount,
    source: r.source,
  };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath, rows) {
  const cols = Object.keys(rows[0] || {});
  const lines = [cols.join(',')];
  for (const row of rows) {
    lines.push(cols.map((c) => csvEscape(row[c])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n'));
}

function bandLabel(lo, hi) {
  return `${lo.toFixed(2)}-${hi.toFixed(2)}`;
}

function computeConfidenceDistribution(rows) {
  const validators = {
    opening: (r) => r.openingConfidence,
    envelope: (r) => r.envelopeConfidence,
    flooring: (r) => r.flooringConfidence,
    fixture: (r) => r.fixtureConfidence,
  };

  const out = {};
  for (const [name, getter] of Object.entries(validators)) {
    const counts = Object.fromEntries(BANDS.map(([lo, hi]) => [bandLabel(lo, hi), 0]));
    for (const r of rows) {
      const v = getter(r);
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      for (let i = 0; i < BANDS.length; i++) {
        const [lo, hi] = BANDS[i];
        const inBand = i === BANDS.length - 1 ? (v >= lo && v <= hi) : (v >= lo && v < hi);
        if (inBand) {
          counts[bandLabel(lo, hi)] += 1;
          break;
        }
      }
    }
    out[name] = counts;
  }
  return out;
}

function computeEscapedFailures(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.published) continue;

    const checks = [
      { validator: 'opening', status: r.openingStatus, confidence: r.openingConfidence, hardFail: r.openingHardFail, reason: r.openingReason },
      { validator: 'envelope', status: r.envelopeStatus, confidence: r.envelopeConfidence, hardFail: r.envelopeHardFail, reason: r.envelopeReason },
      { validator: 'flooring', status: r.flooringStatus, confidence: r.flooringConfidence, hardFail: r.flooringHardFail, reason: r.flooringReason },
      { validator: 'fixture', status: r.fixtureStatus, confidence: r.fixtureConfidence, hardFail: r.fixtureHardFail, reason: r.fixtureReason },
    ];

    for (const c of checks) {
      if (String(c.status || '').toLowerCase() === 'fail') {
        out.push({
          jobId: r.jobId,
          imageId: r.imageId,
          validator: c.validator,
          confidence: c.confidence,
          hardFail: c.hardFail,
          reason: c.reason,
          stage2ImageSignedUrl: r.stage2ImageSignedUrl,
          batchId: r.batchId,
        });
      }
    }
  }
  return out;
}

function computeThresholdSimulation(rows) {
  const validators = [
    { name: 'opening', c: 'openingConfidence', h: 'openingHardFail', current: 0.9 },
    { name: 'envelope', c: 'envelopeConfidence', h: 'envelopeHardFail', current: null },
    { name: 'flooring', c: 'flooringConfidence', h: 'flooringHardFail', current: 0.9 },
    { name: 'fixture', c: 'fixtureConfidence', h: 'fixtureHardFail', current: 0.9 },
  ];

  const scenarios = [
    { label: 'Current Threshold', threshold: null },
    { label: 'Alternative Threshold A', threshold: 0.85 },
    { label: 'Alternative Threshold B', threshold: 0.8 },
    { label: 'Alternative Threshold C', threshold: 0.75 },
  ];

  const result = [];

  for (const v of validators) {
    const currentThreshold = v.current;

    const currentAdditional = rows.filter((r) => {
      const conf = r[v.c];
      const hard = !!r[v.h];
      if (typeof conf !== 'number') return false;
      if (currentThreshold == null) return false;
      return !hard && conf >= currentThreshold;
    }).length;

    for (const s of scenarios) {
      const t = s.threshold == null ? currentThreshold : s.threshold;
      let additional = 0;
      if (t != null) {
        additional = rows.filter((r) => {
          const conf = r[v.c];
          const hard = !!r[v.h];
          if (typeof conf !== 'number') return false;
          return !hard && conf >= t;
        }).length;
      }

      result.push({
        validator: v.name,
        scenario: s.label,
        threshold: t,
        additionalImagesWouldHardFail: additional,
        additionalVsCurrentScenario: t == null ? 0 : (additional - currentAdditional),
      });
    }
  }

  return result;
}

function writeMarkdownSummary(filePath, rows, confidence, escaped, sim, sources) {
  const lines = [];
  lines.push('# Specialist Validator Review Package');
  lines.push('');
  lines.push('## Scope');
  lines.push(`- Total rows: ${rows.length}`);
  lines.push(`- Batches: ${[...new Set(rows.map((r) => r.batchId))].join(', ')}`);
  lines.push(`- Sources: ${sources.join(', ')}`);
  lines.push('');
  lines.push('## Notes');
  lines.push('- This package is data-only. No validation code or thresholds were modified.');
  lines.push('- Fields not present in source artifacts are emitted as empty values.');
  lines.push('');
  lines.push('## Escaped Specialist Failures (fail + published=true)');
  lines.push(`- Count: ${escaped.length}`);
  lines.push('');
  lines.push('## Confidence Bands');
  for (const [validator, bands] of Object.entries(confidence)) {
    lines.push(`### ${validator}`);
    for (const [band, count] of Object.entries(bands)) {
      lines.push(`- ${band}: ${count}`);
    }
    lines.push('');
  }
  lines.push('## Threshold Simulation (Additional Images)');
  for (const row of sim) {
    lines.push(`- ${row.validator} | ${row.scenario} | threshold=${row.threshold ?? 'n/a'} | additional=${row.additionalImagesWouldHardFail} | deltaVsCurrent=${row.additionalVsCurrentScenario}`);
  }
  lines.push('');

  fs.writeFileSync(filePath, lines.join('\n'));
}

function main() {
  const prod = parseProductionLogBatch();
  const second = parseSecondBatch();

  const mergedRows = [...prod.rows, ...second.rows].map(flattenRow);

  const escaped = computeEscapedFailures(mergedRows);
  const confidence = computeConfidenceDistribution(mergedRows);
  const simulation = computeThresholdSimulation(mergedRows);

  const datasetCsv = path.join(OUT_DIR, 'validator_review_dataset.csv');
  const datasetJson = path.join(OUT_DIR, 'validator_review_dataset.json');
  const escapedCsv = path.join(OUT_DIR, 'escaped_specialist_failures.csv');
  const escapedJson = path.join(OUT_DIR, 'escaped_specialist_failures.json');
  const confidenceJson = path.join(OUT_DIR, 'confidence_distribution.json');
  const simulationJson = path.join(OUT_DIR, 'threshold_simulation.json');
  const summaryMd = path.join(OUT_DIR, 'REVIEW_SUMMARY.md');

  if (mergedRows.length === 0) {
    throw new Error('No rows extracted from selected sources.');
  }

  writeCsv(datasetCsv, mergedRows);
  fs.writeFileSync(datasetJson, JSON.stringify(mergedRows, null, 2));

  if (escaped.length > 0) {
    writeCsv(escapedCsv, escaped);
  } else {
    fs.writeFileSync(escapedCsv, 'jobId,imageId,validator,confidence,hardFail,reason,stage2ImageSignedUrl,batchId\n');
  }
  fs.writeFileSync(escapedJson, JSON.stringify(escaped, null, 2));

  fs.writeFileSync(confidenceJson, JSON.stringify(confidence, null, 2));
  fs.writeFileSync(simulationJson, JSON.stringify(simulation, null, 2));

  writeMarkdownSummary(summaryMd, mergedRows, confidence, escaped, simulation, [
    path.basename(LOG_PATH),
    path.basename(SECOND_BATCH_PATH),
  ]);

  console.log('Wrote review package to', OUT_DIR);
  console.log('Rows:', mergedRows.length);
  console.log('Escaped failures:', escaped.length);
}

main();
