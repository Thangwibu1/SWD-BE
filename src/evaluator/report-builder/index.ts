import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../utils/logger.js';

export interface ArtifactEntry {
  type: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface ManifestData {
  experimentId: string;
  runId: string;
  generatedAt: string;
  artifacts: ArtifactEntry[];
}

/**
 * Generate SHA-256 hash of a file.
 */
function sha256File(filePath: string): string {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Scan a directory recursively and build artifact entries.
 */
function scanArtifacts(baseDir: string, prefix: string = ''): ArtifactEntry[] {
  const entries: ArtifactEntry[] = [];

  if (!existsSync(baseDir)) return entries;

  for (const name of readdirSync(baseDir)) {
    const fullPath = path.join(baseDir, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      entries.push(...scanArtifacts(fullPath, relativePath));
    } else {
      const type = categorizeArtifact(relativePath);
      entries.push({
        type,
        relativePath,
        sha256: sha256File(fullPath),
        sizeBytes: stat.size,
      });
    }
  }

  return entries;
}

function categorizeArtifact(relativePath: string): string {
  if (relativePath.startsWith('input/')) return 'input';
  if (relativePath.startsWith('raw/')) return 'raw';
  if (relativePath.startsWith('derived/')) return 'derived';
  if (relativePath === 'report.html') return 'report';
  if (relativePath === 'manifest.json') return 'manifest';
  if (relativePath === 'environment.json') return 'environment';
  return 'other';
}

/**
 * Build the manifest.json for a run's artifacts.
 */
export function buildManifest(
  runDir: string,
  experimentId: string,
  runId: string,
  logger: Logger,
): ManifestData {
  const artifacts = scanArtifacts(runDir).filter(a => a.relativePath !== 'manifest.json');

  const manifest: ManifestData = {
    experimentId,
    runId,
    generatedAt: new Date().toISOString(),
    artifacts,
  };

  const manifestPath = path.join(runDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  logger.info({ artifactCount: artifacts.length, runId }, 'Manifest built');
  return manifest;
}

/**
 * Generate a simple HTML report from derived results.
 */
export function buildReport(
  runDir: string,
  data: {
    experimentName: string;
    architectureId: string;
    workload: string;
    loadRps: number;
    metrics: Record<string, unknown>;
    cost: Record<string, unknown>;
    gates: Record<string, unknown>;
    scores: Record<string, unknown>;
    invariants: Record<string, unknown>;
  },
  logger: Logger,
): void {
  const derivedDir = path.join(runDir, 'derived');
  if (!existsSync(derivedDir)) {
    mkdirSync(derivedDir, { recursive: true });
  }

  // Write derived JSON files
  writeFileSync(path.join(derivedDir, 'metrics.json'), JSON.stringify(data.metrics, null, 2));
  writeFileSync(path.join(derivedDir, 'cost.json'), JSON.stringify(data.cost, null, 2));
  writeFileSync(path.join(derivedDir, 'gates.json'), JSON.stringify(data.gates, null, 2));
  writeFileSync(path.join(derivedDir, 'scores.json'), JSON.stringify(data.scores, null, 2));

  // Build HTML report
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Experiment Report: ${escapeHtml(data.experimentName)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; color: #333; }
    h1 { color: #1a1a2e; border-bottom: 2px solid #16213e; padding-bottom: 10px; }
    h2 { color: #16213e; margin-top: 30px; }
    table { border-collapse: collapse; width: 100%; margin: 15px 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background-color: #f4f4f4; font-weight: 600; }
    .pass { color: #27ae60; font-weight: bold; }
    .fail { color: #e74c3c; font-weight: bold; }
    .metric-value { font-family: 'Courier New', monospace; }
    pre { background: #f8f9fa; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .summary-card { background: #f0f4f8; padding: 20px; border-radius: 8px; margin: 15px 0; }
  </style>
</head>
<body>
  <h1>Experiment Report</h1>
  <div class="summary-card">
    <p><strong>Name:</strong> ${escapeHtml(data.experimentName)}</p>
    <p><strong>Architecture:</strong> ${escapeHtml(data.architectureId)}</p>
    <p><strong>Workload:</strong> ${escapeHtml(data.workload)}</p>
    <p><strong>Load:</strong> ${data.loadRps} RPS</p>
    <p><strong>Generated:</strong> ${new Date().toISOString()}</p>
  </div>

  <h2>Metrics</h2>
  <pre>${JSON.stringify(data.metrics, null, 2)}</pre>

  <h2>Hard Gates</h2>
  <pre>${JSON.stringify(data.gates, null, 2)}</pre>

  <h2>Cost Analysis</h2>
  <pre>${JSON.stringify(data.cost, null, 2)}</pre>

  <h2>Dimension Scores</h2>
  <pre>${JSON.stringify(data.scores, null, 2)}</pre>

  <h2>Invariant Oracle</h2>
  <pre>${JSON.stringify(data.invariants, null, 2)}</pre>
</body>
</html>`;

  writeFileSync(path.join(runDir, 'report.html'), html);

  // Comparison CSV row
  const csvRow = [
    data.architectureId,
    data.workload,
    data.loadRps,
    JSON.stringify(data.metrics),
  ].join(',');
  writeFileSync(path.join(runDir, 'comparison-row.csv'), csvRow);

  logger.info({ runDir }, 'Report built');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
