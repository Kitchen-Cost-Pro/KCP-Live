const expected = 'phase73-yoco-refund-original-order-resolution';
const endpoint = process.env.KCP_API_BASE_URL
  ? `${String(process.env.KCP_API_BASE_URL).replace(/\/+$/, '')}/api/runtime-version`
  : 'https://kcp-api-v2.adminkitchencostpro.workers.dev/api/runtime-version';

try {
  const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (payload.workerRelease !== expected) {
    console.error(`Worker release mismatch. Expected ${expected}, received ${payload.workerRelease || 'not reported'}.`);
    process.exitCode = 1;
  } else {
    console.log(`Worker release verified: ${payload.workerRelease}`);
    console.log(`Refund pipeline: ${payload.refundPipelineVersion || 'not reported'}`);
  }
} catch (error) {
  console.error(`Could not verify ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
