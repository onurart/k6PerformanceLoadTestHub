import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const env = __ENV;
function positiveInt(name, fallback) {
  const value = Number(env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} pozitif bir tam sayı olmalıdır`);
  return value;
}
function numberInRange(name, fallback, min, max) {
  const value = Number(env[name] || fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name}, ${min}-${max} aralığında olmalıdır`);
  return value;
}

const TARGET_URL = env.TARGET_URL || 'https://games.hubgmng.com';
const ALLOWED_HOST = env.ALLOWED_HOST || 'games.hubgmng.com';
const SCENARIO = env.SCENARIO || 'smoke';
const REGION = env.REGION_TAG || 'local';
const MACHINE_COUNT = positiveInt('MACHINE_COUNT', 1);
const MACHINE_INDEX = Number(env.MACHINE_INDEX || 0);
const GLOBAL_MAX_RPS = positiveInt('MAX_RPS', 5);
const GLOBAL_MAX_VUS = positiveInt('MAX_VUS', 5);
const TEST_DURATION = env.TEST_DURATION || '1m';
const WARMUP_DURATION = env.WARMUP_DURATION || '15s';
const TOTAL_DURATION = env.TOTAL_DURATION || '2h';
const TOTAL_REQUESTS = positiveInt('TOTAL_REQUESTS', 50000);
const P95_LIMIT_MS = positiveInt('P95_LIMIT_MS', 1500);
const ERROR_RATE_LIMIT = numberInRange('ERROR_RATE_LIMIT', 0.02, 0.0001, 1);
const REQUEST_TIMEOUT = env.REQUEST_TIMEOUT || '10s';
const LOG_EACH_REQUEST = env.LOG_EACH_REQUEST !== 'false';

if (!['smoke', 'load', 'stress', 'spike', 'volume'].includes(SCENARIO)) throw new Error('SCENARIO: smoke, load, stress, spike veya volume olmalıdır');
if (!Number.isInteger(MACHINE_INDEX) || MACHINE_INDEX < 0 || MACHINE_INDEX >= MACHINE_COUNT) throw new Error('MACHINE_INDEX sıfır tabanlı olmalı ve MACHINE_COUNT değerinden küçük olmalıdır');
if (MACHINE_COUNT > GLOBAL_MAX_RPS || MACHINE_COUNT > GLOBAL_MAX_VUS) throw new Error('MACHINE_COUNT, MAX_RPS ve MAX_VUS değerlerini aşamaz');

// k6 çalışma zamanı tarayıcıdaki URL globalini sağlamaz; origin'i dar bir desenle doğrula.
const targetMatch = TARGET_URL.match(/^(https?):\/\/([^\/?#]+)$/);
if (!targetMatch || targetMatch[2].includes('@')) throw new Error('TARGET_URL yalnızca origin içermelidir (ör. https://games.hubgmng.com)');
if (targetMatch[2].toLowerCase() !== ALLOWED_HOST.toLowerCase()) {
  throw new Error(`Güvenlik kilidi: TARGET_URL hostu (${targetMatch[2]}) ALLOWED_HOST (${ALLOWED_HOST}) ile aynı olmalıdır`);
}
const target = { origin: TARGET_URL };

function parseEndpoints() {
  const raw = env.ENDPOINTS_JSON || '[{"name":"home","method":"GET","path":"/","expected_statuses":[200]}]';
  let endpoints;
  try { endpoints = JSON.parse(raw); } catch (_) { throw new Error('ENDPOINTS_JSON geçerli JSON olmalıdır'); }
  if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error('ENDPOINTS_JSON boş olmayan bir dizi olmalıdır');
  return endpoints.map((item, index) => {
    if (!item || typeof item.path !== 'string' || !item.path.startsWith('/') || item.path.startsWith('//') || item.path.includes('\\')) {
      throw new Error(`Endpoint ${index}: aynı origin üzerinde / ile başlayan güvenli bir path olmalıdır`);
    }
    const url = `${target.origin}${item.path}`;
    const method = String(item.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`Endpoint ${index}: desteklenmeyen method`);
    if (!['GET', 'HEAD'].includes(method) && (env.ALLOW_STATE_CHANGING !== 'true' || env.TEST_ENVIRONMENT !== 'true' || !env.TEST_ACCOUNT_ID)) {
      throw new Error('Yazma işlemleri için ALLOW_STATE_CHANGING=true, TEST_ENVIRONMENT=true ve TEST_ACCOUNT_ID zorunludur');
    }
    const statuses = item.expected_statuses || [200];
    if (!Array.isArray(statuses) || statuses.some((s) => !Number.isInteger(s))) throw new Error(`Endpoint ${index}: expected_statuses tam sayı dizisi olmalıdır`);
    return {
      name: String(item.name || `endpoint_${index}`), method, url,
      body: item.body === undefined ? null : (typeof item.body === 'string' ? item.body : JSON.stringify(item.body)),
      contentType: item.content_type || 'application/json', statuses,
      expectedBody: item.expected_body === undefined ? null : String(item.expected_body),
    };
  });
}
const ENDPOINTS = parseEndpoints();

// Kesin toplam limit: bölüm + ilk kalan makinelere birer birim.
function shard(total) { return Math.floor(total / MACHINE_COUNT) + (MACHINE_INDEX < total % MACHINE_COUNT ? 1 : 0); }
const LOCAL_MAX_RPS = shard(GLOBAL_MAX_RPS);
const LOCAL_MAX_VUS = shard(GLOBAL_MAX_VUS);
const preAllocatedVUs = Math.max(1, Math.min(LOCAL_MAX_VUS, Math.ceil(LOCAL_MAX_RPS / 2)));
function rate(pct) { return Math.max(1, Math.min(LOCAL_MAX_RPS, Math.ceil(LOCAL_MAX_RPS * pct))); }

function scenarioConfig() {
  const common = { executor: 'ramping-arrival-rate', timeUnit: '1s', preAllocatedVUs, maxVUs: LOCAL_MAX_VUS, gracefulStop: '5s' };
  if (SCENARIO === 'volume') return {
    executor: 'constant-arrival-rate', rate: shard(TOTAL_REQUESTS), timeUnit: TOTAL_DURATION,
    duration: TOTAL_DURATION, preAllocatedVUs, maxVUs: LOCAL_MAX_VUS, gracefulStop: '5s',
  };
  if (SCENARIO === 'smoke') return { ...common, startRate: 1, stages: [{ target: 1, duration: WARMUP_DURATION }, { target: 1, duration: TEST_DURATION }] };
  if (SCENARIO === 'load') return { ...common, startRate: 1, stages: [
    { target: rate(.5), duration: WARMUP_DURATION }, { target: LOCAL_MAX_RPS, duration: TEST_DURATION }, { target: rate(.25), duration: '10s' },
  ] };
  if (SCENARIO === 'stress') return { ...common, startRate: 1, stages: [
    { target: rate(.25), duration: WARMUP_DURATION }, { target: rate(.5), duration: TEST_DURATION },
    { target: rate(.75), duration: TEST_DURATION }, { target: LOCAL_MAX_RPS, duration: TEST_DURATION }, { target: 1, duration: '10s' },
  ] };
  return { ...common, startRate: 1, stages: [
    { target: rate(.2), duration: WARMUP_DURATION }, { target: LOCAL_MAX_RPS, duration: '10s' },
    { target: LOCAL_MAX_RPS, duration: TEST_DURATION }, { target: 1, duration: '10s' },
  ] };
}

const failedRequests = new Rate('failed_requests');
const responseDuration = new Trend('response_duration', true);
const timeouts = new Counter('timeouts');
const contentFailures = new Counter('content_failures');
const statusCodes = new Counter('status_codes');
const status2xx = new Counter('status_2xx');
const status3xx = new Counter('status_3xx');
const status4xx = new Counter('status_4xx');
const status5xx = new Counter('status_5xx');
const TRACKED_STATUS_CODES = [0, 200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504];
const endpointMetrics = {};
for (const endpoint of ENDPOINTS) {
  const metricName = endpoint.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const statuses = {};
  for (const code of TRACKED_STATUS_CODES) statuses[code] = new Counter(`endpoint_${metricName}_status_${code}`);
  endpointMetrics[endpoint.name] = {
    metricName,
    total: new Counter(`endpoint_${metricName}_total`),
    failed: new Counter(`endpoint_${metricName}_failed`),
    other: new Counter(`endpoint_${metricName}_status_other`),
    statuses,
  };
}

export const options = {
  scenarios: { [SCENARIO]: scenarioConfig() },
  discardResponseBodies: false,
  userAgent: '',
  tags: { region: REGION, machine_index: String(MACHINE_INDEX), scenario: SCENARIO },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    failed_requests: [{ threshold: `rate<${ERROR_RATE_LIMIT}`, abortOnFail: true, delayAbortEval: WARMUP_DURATION }],
    response_duration: [{ threshold: `p(95)<${P95_LIMIT_MS}`, abortOnFail: true, delayAbortEval: WARMUP_DURATION }],
  },
};

export function setup() {
  console.log(JSON.stringify({ event: 'test_config', target: target.origin, scenario: SCENARIO, region: REGION,
    machine: `${MACHINE_INDEX + 1}/${MACHINE_COUNT}`, local_max_rps: LOCAL_MAX_RPS, local_max_vus: LOCAL_MAX_VUS,
    global_max_rps: GLOBAL_MAX_RPS, global_max_vus: GLOBAL_MAX_VUS,
    total_requests: SCENARIO === 'volume' ? TOTAL_REQUESTS : null,
    total_duration: SCENARIO === 'volume' ? TOTAL_DURATION : null }));
}

export default function () {
  const endpoint = ENDPOINTS[exec.scenario.iterationInTest % ENDPOINTS.length];
  const tags = { endpoint: endpoint.name, region: REGION };
  const headers = { 'User-Agent': '', Accept: '*/*' };
  if (endpoint.body !== null) headers['Content-Type'] = endpoint.contentType;
  const response = http.request(endpoint.method, endpoint.url, endpoint.body, {
    headers, redirects: 0, timeout: REQUEST_TIMEOUT, tags,
  });
  const statusOK = endpoint.statuses.includes(response.status);
  const bodyOK = endpoint.expectedBody === null || (response.body !== null && response.body.includes(endpoint.expectedBody));
  check(response, { 'beklenen HTTP durumu': () => statusOK, 'beklenen yanıt içeriği': () => bodyOK }, tags);
  const timedOut = response.error_code === 1050 || String(response.error || '').toLowerCase().includes('timeout');
  const requestOK = statusOK && bodyOK && !timedOut;
  const endpointMetric = endpointMetrics[endpoint.name];
  failedRequests.add(!statusOK || !bodyOK || timedOut, tags);
  responseDuration.add(response.timings.duration, tags);
  statusCodes.add(1, { ...tags, status: String(response.status || 0) });
  endpointMetric.total.add(1);
  if (!requestOK) endpointMetric.failed.add(1);
  if (endpointMetric.statuses[response.status]) endpointMetric.statuses[response.status].add(1);
  else endpointMetric.other.add(1, { status: String(response.status || 0) });
  if (response.status >= 200 && response.status < 300) status2xx.add(1, tags);
  else if (response.status >= 300 && response.status < 400) status3xx.add(1, tags);
  else if (response.status >= 400 && response.status < 500) status4xx.add(1, tags);
  else if (response.status >= 500 && response.status < 600) status5xx.add(1, tags);
  if (timedOut) timeouts.add(1, tags);
  if (!bodyOK) contentFailures.add(1, tags);
  if (LOG_EACH_REQUEST) {
    console.log([
      new Date().toISOString(), requestOK ? 'BAŞARILI' : 'BAŞARISIZ', endpoint.method,
      endpoint.name, `HTTP=${response.status || 0}`, `SÜRE=${response.timings.duration.toFixed(2)}ms`,
      timedOut ? 'TIMEOUT=EVET' : 'TIMEOUT=HAYIR',
    ].join(' | '));
  }
}

export function handleSummary(data) {
  const output = {
    generated_at: new Date().toISOString(), target: target.origin, scenario: SCENARIO, region: REGION,
    machine_index: MACHINE_INDEX, machine_count: MACHINE_COUNT,
    limits: { global_max_rps: GLOBAL_MAX_RPS, global_max_vus: GLOBAL_MAX_VUS, local_max_rps: LOCAL_MAX_RPS, local_max_vus: LOCAL_MAX_VUS },
    metrics: data.metrics,
  };
  const values = (name) => data.metrics[name] ? data.metrics[name].values : {};
  const duration = values('response_duration');
  const requests = values('http_reqs');
  const failures = values('failed_requests');
  const line = (label, value) => `${label.padEnd(24)} ${value === undefined ? 0 : value}`;
  const endpointReport = ['', '=== Endpoint durum kodları ==='];
  for (const endpoint of ENDPOINTS) {
    const metric = endpointMetrics[endpoint.name];
    const statusParts = [];
    for (const code of TRACKED_STATUS_CODES) {
      const count = values(`endpoint_${metric.metricName}_status_${code}`).count || 0;
      if (count > 0) statusParts.push(`${code}=${count}`);
    }
    const other = values(`endpoint_${metric.metricName}_status_other`).count || 0;
    if (other > 0) statusParts.push(`diğer=${other}`);
    const total = values(`endpoint_${metric.metricName}_total`).count || 0;
    const failed = values(`endpoint_${metric.metricName}_failed`).count || 0;
    endpointReport.push(`${endpoint.name} (${endpoint.method} ${endpoint.url.slice(target.origin.length)})`);
    endpointReport.push(`  toplam=${total} başarısız=${failed} | ${statusParts.join(' ') || 'yanıt yok'}`);
  }
  const report = [
    '', '=== k6 kapasite testi özeti ===',
    line('Hedef', target.origin), line('Senaryo / Bölge', `${SCENARIO} / ${REGION}`),
    line('Hedeflenen max RPS', GLOBAL_MAX_RPS), line('Toplam istek', requests.count),
    line('Gerçek ortalama RPS', Number(requests.rate || 0).toFixed(2)),
    line('Başarısız oran', `${(Number(failures.rate || 0) * 100).toFixed(2)}%`),
    line('p50 gecikme', `${Number(duration.med || 0).toFixed(2)} ms`),
    line('p95 gecikme', `${Number(duration['p(95)'] || 0).toFixed(2)} ms`),
    line('p99 gecikme', `${Number(duration['p(99)'] || 0).toFixed(2)} ms`),
    line('HTTP 2xx', values('status_2xx').count), line('HTTP 3xx', values('status_3xx').count),
    line('HTTP 4xx', values('status_4xx').count), line('HTTP 5xx', values('status_5xx').count),
    line('Timeout', values('timeouts').count), line('İçerik hatası', values('content_failures').count),
    line('Atlanan iterasyon', values('dropped_iterations').count),
    ...endpointReport, '',
  ].join('\n');
  const result = { stdout: report };
  if (env.SAVE_JSON_RESULTS === 'true') result[`results/summary-${REGION}-${MACHINE_INDEX}.json`] = JSON.stringify(output, null, 2);
  return result;
}
