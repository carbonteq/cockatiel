import Redis from "ioredis";
import { CircuitState } from '../CircuitBreakerPolicy';



interface IWindow {
  startedAt: number;
  failures: number;
  successes: number;
}

export interface IRedisSamplingBreakerOptions {
  /**
   * Percentage (from 0 to 1) of requests that need to fail before we'll
   * open the circuit.
   */
  threshold: number;

  /**
   * Length of time over which to sample.
   */
  duration: number;

  redisClient: Redis;

  /**
   * Minimum number of RPS needed to be able to (potentially) open the circuit.
   * Useful to avoid unnecessarily tripping under low load.
   */
  minimumRps?: number;
}

interface IBreaker {
  /**
   * Called when a call succeeds.
   */
  success(state: CircuitState): void;
  /**
   * Called when a call fails. Returns true if the circuit should open.
   */
  failure(state: CircuitState): Promise<boolean>;
}

export class RedisSamplingBreaker implements IBreaker {
  private readonly threshold: number;
  private readonly duration: number;
  private readonly redisClient: Redis;
  private readonly minimumRpms: number;
  private readonly windowSize: number;

  private windows: IWindow[] = [];

  /**
   * SamplingBreaker breaks if more than `threshold` percentage of calls over the
   * last `samplingDuration`, so long as there's at least `minimumRps` (to avoid
   * closing unnecessarily under low RPS).
   */

  constructor(options: IRedisSamplingBreakerOptions) {
    const {
      threshold,
      duration: samplingDuration,
      redisClient,
      minimumRps,
    } = options
    if (threshold <= 0 || threshold >= 1) {
      throw new RangeError(
        `SamplingBreaker threshold should be between (0, 1), got ${threshold}`
      );
    }

    this.threshold = threshold;
    this.redisClient = redisClient

    // at least 5 windows, max 1 second each:
    const windowCount = Math.max(5, Math.ceil(samplingDuration / 1000));
    for (let i = 0; i < windowCount; i++) {
      this.windows.push({ startedAt: 0, failures: 0, successes: 0 });
    }

    this.windowSize = Math.round(samplingDuration / windowCount);
    this.duration = this.windowSize * windowCount;


    if (minimumRps) {
      this.minimumRpms = minimumRps / 1000;
    } else {
      // for our rps guess, set it so at least 5 failures per second
      // are needed to open the circuit
      this.minimumRpms = 5 / (threshold * 1000);
    }
    this.redisClient.set("windows", JSON.stringify(this.windows));
    this.redisClient.set("windowSize", this.windowSize);
    this.redisClient.set("duration", this.duration);
    this.redisClient.set("minimumRpms", this.minimumRpms);
    this.redisClient.set("currentWindow", 0);
    this.redisClient.set("currentFailures", 0);
    this.redisClient.set("currentSuccesses", 0);
  }

  /**
   * @inheritdoc
   */
  public success(state: CircuitState) {
    if (state === CircuitState.HalfOpen) {
      this.resetWindows();
    }

    this.push(true);
  }

  /**
   * @inheritdoc
   */
  public async failure(state: CircuitState) {
    this.push(false);

    if (state !== CircuitState.Closed) {
      return true;
    }

    const redisCurrentSuccess = await this.redisClient.get("currentSuccesses");
    const currentSuccesses = Number(redisCurrentSuccess);
    const redisCurrentFailures = await this.redisClient.get("currentFailures");
    const currentFailures = Number(redisCurrentFailures);

    const total = currentSuccesses + currentFailures;

    // If we don't have enough rps, then the circuit is open.
    // 1. `total / samplingDuration` gets rps
    // 2. We want `rpms < minimumRpms`
    // 3. Simplifies to `total < samplingDuration * minimumRps`
    const redisDuration = await this.redisClient.get("duration");
    const duration = Number(redisDuration);
    const redisMinimumRpms = await this.redisClient.get("minimumRpms");
    const minimumRpms = Number(redisMinimumRpms);
    if (total < duration * minimumRpms) {
      return false;
    }

    // If we're above threshold, open the circuit
    // 1. `failures / total > threshold`
    // 2. `failures > threshold * total`
    if (currentFailures > this.threshold * total) {
      return true;
    }

    return false;
  }

  private async resetWindows() {
    const redisWindows = await this.redisClient.get("windows");
    //@ts-ignore
    const windows = JSON.parse(redisWindows);
    for (const window of windows) {
      window.failures = 0;
      window.successes = 0;
      window.startedAt = 0;
    }
    this.redisClient.set("currentFailures", 0);
    this.redisClient.set("currentSuccesses", 0);
    this.redisClient.set("windows", JSON.stringify(windows));
  }

  private async rotateWindow(now: number) {
    const redisWindows = await this.redisClient.get("windows");
    //@ts-ignore
    const windows = JSON.parse(redisWindows);
    const redisCurrentWindow = await this.redisClient.get("currentWindow");
    const currentWindow = Number(redisCurrentWindow);
    const next = (currentWindow + 1) % windows.length;
    const nextFailures = windows[next].failures;
    this.redisClient.set("currentFailures", nextFailures - 1);
    const nextSuccesses = windows[next].successes;
    this.redisClient.set("currentSuccesses", nextSuccesses - 1);

    const window = (windows[next] = {
      failures: 0,
      successes: 0,
      startedAt: now,
    });

    this.redisClient.set("currentWindow", next);

    return window;
  }

  private async push(success: boolean) {
    const now = Date.now();
    const redisWindows = await this.redisClient.get("windows");
    const redisCurrentWindow = await this.redisClient.get("currentWindow");
    const currentWindow = Number(redisCurrentWindow);
    //@ts-ignore
    const windows = JSON.parse(redisWindows);
    let window = windows[currentWindow];
    if (now - window.startedAt >= this.windowSize) {
      window = this.rotateWindow(now);
    }
    const redisNextWindow = await this.redisClient.get("currentWindow");
    const nextWindow = Number(redisNextWindow);
    // Increment current counts
    if (success) {
      const window = windows[nextWindow];
      const redisCurrentSuccess = await this.redisClient.get("currentSuccesses");
      const currentSuccesses = Number(redisCurrentSuccess);
      window.successes++;
      this.redisClient.set("currentSuccesses", currentSuccesses + 1);
    } else {
      const window = windows[nextWindow];
      const redisCurrentFailures = await this.redisClient.get("currentFailures");
      const currentFailures = Number(redisCurrentFailures);
      this.redisClient.set("currentSuccesses", currentFailures + 1);
      window.failures++;
    }
    this.redisClient.set("windows", JSON.stringify(windows));
  }
}
