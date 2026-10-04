import { spawn, type ChildProcess } from "child_process";
import { Database } from "bun:sqlite";

const GATEWAY_PORT = 3000;
const MOCK_UPSTREAM_PORT = 4000;
const CLIENT_KEY = "sk-rizuu-bench-benchmark-test-key-12345";
const UPSTREAM_ID = "upstream-bench-mock";

// 1. Prepare SQLite Database with Benchmarking Keys
function setupBenchmarkingDb() {
  console.log("📦 [1/5] Setting up mock upstream and client key in database...");
  const db = new Database("data/router.db");
  const now = Date.now();

  // Clean old bench records if any
  db.run("DELETE FROM client_keys WHERE id = 'bench-client-id'");
  db.run("DELETE FROM upstream_keys WHERE id = ?", [UPSTREAM_ID]);

  // Insert mock upstream
  db.run(
    `INSERT INTO upstream_keys (
      id, provider, name, api_key, models, base_url, is_active, round_robin, weight, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
    [
      UPSTREAM_ID,
      "openai",
      "Mock Upstream Provider",
      "sk-mock-upstream-key",
      JSON.stringify([{ id: "gpt-4o", name: "GPT-4o (Mock)", enabled: true }]),
      `http://127.0.0.1:${MOCK_UPSTREAM_PORT}/v1`,
      now,
      now,
    ]
  );

  // Insert test client key
  db.run(
    `INSERT INTO client_keys (
      id, name, key, is_active, rate_limit, token_limit, used_tokens, allowed_providers, round_robin_providers, is_follow_upstream, created_at
    ) VALUES (?, ?, ?, 1, NULL, NULL, 0, ?, 1, 0, ?)`,
    [
      "bench-client-id",
      "Bench Client",
      CLIENT_KEY,
      JSON.stringify([UPSTREAM_ID]),
      now,
    ]
  );

  db.close();
  console.log("   ✓ Mock upstream and client key configured in SQLite");
}

// 2. Start Mock OpenAI Upstream Server
function startMockUpstreamServer() {
  console.log(`🤖 [2/5] Starting Mock OpenAI Server on port ${MOCK_UPSTREAM_PORT}...`);
  return Bun.serve({
    port: MOCK_UPSTREAM_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = (await req.json()) as any;
        const isStream = !!body.stream;

        if (isStream) {
          // Stream SSE chunks with 20ms delays (simulating real token generation)
          const chunks = [
            { role: "assistant", content: "Hello! " },
            { content: "This " },
            { content: "is " },
            { content: "a " },
            { content: "streamed " },
            { content: "benchmark " },
            { content: "response." },
          ];

          const stream = new ReadableStream({
            async start(controller) {
              for (let i = 0; i < chunks.length; i++) {
                const chunkData = {
                  id: "chatcmpl-mock",
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: "gpt-4o",
                  choices: [{ index: 0, delta: chunks[i], finish_reason: null }],
                };
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunkData)}\n\n`));
                await Bun.sleep(15); // 15ms per chunk
              }

              // Final usage chunk
              const finalChunk = {
                id: "chatcmpl-mock",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "gpt-4o",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: 15,
                  completion_tokens: 7,
                  total_tokens: 22,
                },
              };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        } else {
          // Non-streaming JSON response
          await Bun.sleep(25);
          return Response.json({
            id: "chatcmpl-mock-json",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Benchmark response from mock upstream." },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 8,
              total_tokens: 20,
            },
          });
        }
      }

      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "gpt-4o", object: "model", created: 1700000000, owned_by: "system" }],
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
}

// 3. Start Rizuu-Router
async function startRizuuRouter(): Promise<ChildProcess> {
  console.log(`🐱 [3/5] Starting Rizuu-Router on port ${GATEWAY_PORT}...`);
  const isWindows = process.platform === "win32";
  const proc = spawn(isWindows ? "bun.exe" : "bun", ["src/index.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    env: { ...process.env, PORT: String(GATEWAY_PORT), NODE_ENV: "production" },
  });

  // Wait for healthcheck
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(400);
    try {
      const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/auth/status`);
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch { }
  }

  if (!ready) {
    throw new Error("Failed to start Rizuu-Router within timeout!");
  }
  console.log("   ✓ Rizuu-Router is online and healthy");
  return proc;
}

// Memory sampler helper
async function getProcessMemoryMB(pid: number): Promise<number> {
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64 / 1MB`]);
      const text = await new Response(proc.stdout).text();
      const mb = parseFloat(text.trim());
      return isNaN(mb) ? 0 : Math.round(mb * 10) / 10;
    }
  } catch { }
  return 0;
}

// 4. Benchmarking Scenarios
interface BenchResult {
  scenario: string;
  concurrency: number;
  durationSeconds: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  requestsPerSec: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  memoryMb: number;
}

async function runScenario(
  name: string,
  concurrency: number,
  durationSeconds: number,
  isStreaming: boolean,
  gatewayPid: number
): Promise<BenchResult> {
  console.log(`\n🚀 [BENCHMARK] ${name}`);
  console.log(`   Concurrency: ${concurrency} constant concurrent clients | Duration: ${durationSeconds}s | Streaming: ${isStreaming}`);

  let totalRequests = 0;
  let successfulRequests = 0;
  let failedRequests = 0;
  const latencies: number[] = [];
  const stopTime = Date.now() + durationSeconds * 1000;
  let peakMemory = 0;

  // Background memory sampler
  const memSampler = setInterval(async () => {
    const mem = await getProcessMemoryMB(gatewayPid);
    if (mem > peakMemory) peakMemory = mem;
  }, 500);

  // Worker task that loops making requests until time is up
  const worker = async () => {
    while (Date.now() < stopTime) {
      const start = performance.now();
      totalRequests++;
      try {
        const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CLIENT_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: `Benchmark message ${totalRequests}` }],
            stream: isStreaming,
          }),
        });

        if (res.status === 200) {
          if (isStreaming) {
            // Consume the entire stream
            const reader = res.body?.getReader();
            if (reader) {
              while (true) {
                const { done } = await reader.read();
                if (done) break;
              }
            }
          } else {
            await res.json();
          }
          successfulRequests++;
        } else {
          failedRequests++;
        }
      } catch (err) {
        failedRequests++;
      }
      const duration = performance.now() - start;
      latencies.push(duration);
    }
  };

  // Launch concurrent workers
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  clearInterval(memSampler);

  latencies.sort((a, b) => a - b);
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p95Latency = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;
  const maxLatency = latencies.length > 0 ? latencies[latencies.length - 1] : 0;
  const rps = totalRequests / durationSeconds;

  console.log(`   Results:`);
  console.log(`   • Total Requests Handled: ${totalRequests} (${successfulRequests} OK, ${failedRequests} Fail)`);
  console.log(`   • Throughput: ${rps.toFixed(1)} req/sec`);
  console.log(`   • Latency: Avg ${avgLatency.toFixed(1)}ms | P95 ${p95Latency.toFixed(1)}ms | Max ${maxLatency.toFixed(1)}ms`);
  console.log(`   • Gateway Peak RAM: ${peakMemory} MB`);

  return {
    scenario: name,
    concurrency,
    durationSeconds,
    totalRequests,
    successfulRequests,
    failedRequests,
    requestsPerSec: parseFloat(rps.toFixed(1)),
    avgLatencyMs: parseFloat(avgLatency.toFixed(1)),
    p95LatencyMs: parseFloat(p95Latency.toFixed(1)),
    maxLatencyMs: parseFloat(maxLatency.toFixed(1)),
    memoryMb: peakMemory,
  };
}

// Main execution
async function main() {
  console.log("==================================================================");
  console.log("       rizuu-ROUTER AI GATEWAY CONCURRENCY BENCHMARK               ");
  console.log("       Evaluating target specs: 1 vCPU, 2 GB RAM, 40 GB SSD       ");
  console.log("==================================================================");

  setupBenchmarkingDb();
  const mockServer = startMockUpstreamServer();
  const gatewayProc = await startRizuuRouter();
  const gatewayPid = gatewayProc.pid!;

  console.log(`   Gateway PID: ${gatewayPid}`);

  const results: BenchResult[] = [];

  try {
    // Warmup
    console.log("\n⏳ Warming up gateway & sqlite connection pool...");
    for (let i = 0; i < 10; i++) {
      await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLIENT_KEY}` },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Warmup" }], stream: true }),
      });
    }

    // Benchmark 1: Constant 12 concurrent streaming clients (1 dozen)
    results.push(
      await runScenario("1 Dozen Constant Streams (12 concurrent SSE)", 12, 10, true, gatewayPid)
    );

    // Benchmark 2: Constant 24 concurrent streaming clients (2 dozen)
    results.push(
      await runScenario("2 Dozen Constant Streams (24 concurrent SSE)", 24, 10, true, gatewayPid)
    );

    // Benchmark 3: Constant 50 concurrent streaming clients (High concurrency)
    results.push(
      await runScenario("Heavy Load: 50 Constant Concurrent SSE Streams", 50, 10, true, gatewayPid)
    );

    // Benchmark 4: Fast Non-Streaming High Throughput (testing DB telemetry write throughput)
    results.push(
      await runScenario("High Throughput Non-Streaming (25 concurrent clients)", 25, 10, false, gatewayPid)
    );

    console.log("\n==================================================================");
    console.log("                       FINAL BENCHMARK REPORT                     ");
    console.log("==================================================================");
    console.log(JSON.stringify(results, null, 2));

    // Cleanup mock keys
    const db = new Database("data/router.db");
    db.run("DELETE FROM client_keys WHERE id = 'bench-client-id'");
    db.run("DELETE FROM upstream_keys WHERE id = ?", [UPSTREAM_ID]);
    db.close();
  } finally {
    console.log("\n🧹 Cleaning up processes...");
    mockServer.stop();
    gatewayProc.kill();
  }
}

main().catch(console.error);
