(() => {
  "use strict";

  const canvas = document.getElementById("factory-canvas");
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  const runStatus = document.getElementById("run-status");
  const nativeStatus = document.getElementById("native-status");
  const instanceCountLabel = document.getElementById("instance-count");
  const frameCountLabel = document.getElementById("frame-count");
  const frameP95Label = document.getElementById("frame-p95");
  const drawP95Label = document.getElementById("draw-p95");
  const longTaskCountLabel = document.getElementById("long-task-count");
  const rendererStartedAt = performance.now();

  function percentile(values, quantile) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
    return Math.round(sorted[index] * 1_000) / 1_000;
  }

  function summarize(values) {
    if (values.length === 0) return { sampleCount: 0, p50: null, p95: null, p99: null, max: null };
    return {
      sampleCount: values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      p99: percentile(values, 0.99),
      max: Math.round(Math.max(...values) * 1_000) / 1_000,
    };
  }

  function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
  }

  function createFixture(instanceCount, seed) {
    const random = createRandom(seed);
    const positions = new Float32Array(instanceCount * 2);
    const sizes = new Float32Array(instanceCount * 2);
    for (let index = 0; index < instanceCount; index += 1) {
      const offset = index * 2;
      positions[offset] = random();
      positions[offset + 1] = random();
      sizes[offset] = 2.5 + random() * 4.5;
      sizes[offset + 1] = 2 + random() * 3.5;
    }
    return { positions, sizes, beltCount: instanceCount };
  }

  function resizeCanvas() {
    const bounds = canvas.getBoundingClientRect();
    const scale = Math.max(0.25, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width, height, scale };
  }

  function javascriptHeapSnapshot() {
    const memory = performance.memory;
    if (!memory) return null;
    return {
      usedBytes: Math.max(0, Math.trunc(memory.usedJSHeapSize)),
      totalBytes: Math.max(0, Math.trunc(memory.totalJSHeapSize)),
      limitBytes: Math.max(0, Math.trunc(memory.jsHeapSizeLimit)),
    };
  }

  async function run() {
    if (!context || !window.dspShellLab) throw new Error("shell lab bridge or canvas is unavailable");
    const configuration = await window.dspShellLab.getConfiguration();
    const fixture = createFixture(configuration.instanceCount, configuration.fixtureSeed);
    const frameIntervals = [];
    const drawDurations = [];
    const inputLatencies = [];
    let longTaskCount = 0;
    let longTaskDurationMs = 0;
    let hiddenFrameCount = 0;
    let previousFrameTimestamp = null;
    let firstFrameMs = null;
    let firstFrameTimestamp = null;
    let lastStatusUpdate = 0;
    let completed = false;

    instanceCountLabel.textContent = configuration.instanceCount.toLocaleString("zh-CN");
    nativeStatus.textContent = configuration.nativeHost.available
      ? `Rust Host：ready · protocol ${configuration.nativeHost.protocolVersion}`
      : `Rust Host：${configuration.nativeHost.state}`;
    runStatus.textContent = `运行 ${Math.round(configuration.durationMs / 1_000)} 秒固定夹具`;

    if (typeof PerformanceObserver === "function") {
      try {
        const observer = new PerformanceObserver((entries) => {
          for (const entry of entries.getEntries()) {
            longTaskCount += 1;
            longTaskDurationMs += entry.duration;
          }
        });
        observer.observe({ type: "longtask", buffered: true });
      } catch {
        // Long Task observation is optional; frame timings remain authoritative.
      }
    }

    window.addEventListener("pointerdown", (event) => {
      if (!event.isTrusted) return;
      const latency = performance.now() - event.timeStamp;
      if (Number.isFinite(latency) && latency >= 0 && latency <= 60_000) inputLatencies.push(latency);
    }, { passive: true });

    const finish = async (durationMs, viewport) => {
      if (completed) return;
      completed = true;
      const frameSummary = summarize(frameIntervals);
      const drawSummary = summarize(drawDurations);
      runStatus.textContent = "采样完成，写入指标";
      const rendererMetrics = {
        schemaVersion: 1,
        fixtureId: configuration.fixtureId,
        fixtureSeed: configuration.fixtureSeed,
        instanceCount: configuration.instanceCount,
        beltCount: fixture.beltCount,
        durationMs: Math.round(durationMs * 1_000) / 1_000,
        frameCount: frameIntervals.length + 1,
        firstFrameMs: Math.round(firstFrameMs * 1_000) / 1_000,
        frameIntervalMs: frameSummary,
        drawDurationMs: drawSummary,
        inputLatencyMs: summarize(inputLatencies),
        longFramesOver16_7Ms: frameIntervals.filter((value) => value > 16.7).length,
        longFramesOver33_3Ms: frameIntervals.filter((value) => value > 33.3).length,
        longFramesOver50Ms: frameIntervals.filter((value) => value > 50).length,
        longTaskCount,
        longTaskDurationMs: Math.round(longTaskDurationMs * 1_000) / 1_000,
        hiddenFrameCount,
        viewport: {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.scale,
        },
        javascriptHeap: javascriptHeapSnapshot(),
      };
      await window.dspShellLab.submitRendererMetrics(rendererMetrics);
      runStatus.textContent = "指标已提交";
    };

    const drawFrame = (timestamp) => {
      if (completed) return;
      const viewport = resizeCanvas();
      const drawStartedAt = performance.now();
      const { width, height } = viewport;
      context.fillStyle = "#07110f";
      context.fillRect(0, 0, width, height);
      context.lineWidth = 0.75 * viewport.scale;
      context.strokeStyle = "rgba(86, 192, 145, 0.22)";
      context.beginPath();
      const horizontalDrift = (timestamp * 0.004) % Math.max(1, width);
      for (let index = 0; index < configuration.instanceCount; index += 1) {
        const offset = index * 2;
        const x = fixture.positions[offset] * width;
        const y = fixture.positions[offset + 1] * height;
        const nextOffset = ((index + 97) % configuration.instanceCount) * 2;
        const targetX = (fixture.positions[nextOffset] * width + horizontalDrift * 0.01) % width;
        const targetY = fixture.positions[nextOffset + 1] * height;
        context.moveTo(x, y);
        context.lineTo(targetX, targetY);
      }
      context.stroke();
      context.fillStyle = "rgba(96, 225, 165, 0.78)";
      for (let index = 0; index < configuration.instanceCount; index += 1) {
        const offset = index * 2;
        const x = fixture.positions[offset] * width;
        const y = fixture.positions[offset + 1] * height;
        context.fillRect(x, y, fixture.sizes[offset] * viewport.scale, fixture.sizes[offset + 1] * viewport.scale);
      }
      drawDurations.push(performance.now() - drawStartedAt);

      if (firstFrameTimestamp === null) {
        firstFrameTimestamp = timestamp;
        firstFrameMs = performance.now() - rendererStartedAt;
      }
      if (previousFrameTimestamp !== null) frameIntervals.push(timestamp - previousFrameTimestamp);
      previousFrameTimestamp = timestamp;
      if (document.hidden) hiddenFrameCount += 1;

      const elapsed = timestamp - firstFrameTimestamp;
      if (elapsed - lastStatusUpdate >= 500) {
        lastStatusUpdate = elapsed;
        frameCountLabel.textContent = String(frameIntervals.length + 1);
        const frameP95 = percentile(frameIntervals, 0.95);
        const drawP95 = percentile(drawDurations, 0.95);
        frameP95Label.textContent = frameP95 === null ? "—" : `${frameP95.toFixed(2)} ms`;
        drawP95Label.textContent = drawP95 === null ? "—" : `${drawP95.toFixed(2)} ms`;
        longTaskCountLabel.textContent = String(longTaskCount);
      }
      if (elapsed >= configuration.durationMs) {
        void finish(elapsed, viewport).catch((error) => {
          runStatus.textContent = `指标提交失败：${error instanceof Error ? error.message : "unknown"}`;
        });
        return;
      }
      requestAnimationFrame(drawFrame);
    };

    requestAnimationFrame(drawFrame);
  }

  void run().catch((error) => {
    runStatus.textContent = `启动失败：${error instanceof Error ? error.message : "unknown"}`;
  });
})();
