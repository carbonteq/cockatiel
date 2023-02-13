import Redis from "ioredis";
import * as moment from "moment";
import { EventEmitter } from './common/Event';
import { FailureReason, IDefaultPolicyContext, IFailureEvent, IPolicy, ISuccessEvent, Policy } from './Policy';

export type FailureOrSuccess<R> = FailureReason<R> | { success: R };

export const returnOrThrow = <R>(failure: FailureOrSuccess<R>) => {
  if ("error" in failure) {
    throw failure.error;
  }

  if ("success" in failure) {
    return failure.success;
  }

  return failure.value;
};

export const neverAbortedSignal = new AbortController().signal;

export class RateLimiterPolicy implements IPolicy {
  declare readonly _altReturn: never;

  /**
   * @inheritdoc
   */
  public readonly onSuccess = this.executor.onSuccess;

  /**
   * @inheritdoc
   */
  public readonly onFailure = this.executor.onFailure;

  constructor(
    private readonly options: {
      redisClient: Redis;
      driver: SlidingWindowCounterDriver | LeakyBucketDriver;
    },
    private readonly executor: ExecuteWrapper
  ) { }

  public async execute<T>(
    fn: (context: IDefaultPolicyContext) => PromiseLike<T> | T,
    signal = neverAbortedSignal
  ): Promise<T> {
    let rateLimitStatus = false;
    const { redisClient, driver } = this.options;
    if (driver instanceof SlidingWindowCounterDriver) {
      rateLimitStatus = await rateLimitExceeded(driver, redisClient);
    } else {
      rateLimitStatus = await leakyBuckedExceeded(driver, redisClient);
    }

    if (rateLimitStatus) {
      throw new Error(`Rate Limit Exceded`);
    }
    const result = await this.executor.invoke(fn, { signal });
    return returnOrThrow(result);
  }
}

export function rateLimiter(
  policy: Policy,
  options: { redisClient: Redis, driver: SlidingWindowCounterDriver | LeakyBucketDriver }
) {
  return new RateLimiterPolicy(
    options,
    new ExecuteWrapper(policy.options.errorFilter, policy.options.resultFilter)
  );
}

async function rateLimitExceeded(
  driver: SlidingWindowCounterDriver,
  redis: Redis
): Promise<boolean> {
  const MAX_WINDOW_REQUEST_COUNT = driver.maxWindowRequestCount;
  const WINDOW_LOG_INTERVAL_IN_SECONDS: Number = driver.intervalInSeconds;
  const record = await redis.get(driver.hash);
  const currentRequestTime = moment();

  if (!record) {
    let newRecord = [];
    let requestLog = {
      requestTimeStamp: currentRequestTime.unix(),
      requestCount: 1,
    };
    newRecord.push(requestLog);
    await redis.set(
      driver.hash,
      JSON.stringify(newRecord),
      "EX",
      Number(WINDOW_LOG_INTERVAL_IN_SECONDS)
    );
    return false;
  }
  // if record is found, parse it's value and calculate number of requests users has made within the last window
  let data = JSON.parse(record);
  let windowStartTimestamp = moment()
    .subtract(`${WINDOW_LOG_INTERVAL_IN_SECONDS}`, "seconds")
    .unix();

  let requestsWithinWindow = data.filter((entry: any) => {
    return entry.requestTimeStamp > windowStartTimestamp;
  });

  let totalWindowRequestsCount = requestsWithinWindow.reduce(
    (accumulator: any, entry: any) => {
      return accumulator + entry.requestCount;
    },
    0
  );

  // if number of requests made is greater than or equal to the desired maximum, return error

  if (totalWindowRequestsCount >= MAX_WINDOW_REQUEST_COUNT) {
    return true;
  } else {
    // if number of requests made is less than allowed maximum, log new entry
    let lastRequestLog = data[data.length - 1];

    let potentialCurrentWindowIntervalStartTimeStamp = currentRequestTime
      .subtract(`${WINDOW_LOG_INTERVAL_IN_SECONDS}`, "seconds")
      .unix();
    //  if interval has not passed since last request log, increment counter

    if (
      lastRequestLog.requestTimeStamp >
      potentialCurrentWindowIntervalStartTimeStamp
    ) {
      lastRequestLog.requestCount++;
      data[data.length - 1] = lastRequestLog;
    } else {
      //  if interval has passed, log new entry for current user and timestamp
      data.push({
        requestTimeStamp: currentRequestTime.unix(),
        requestCount: 1,
      });
    }
    const expirationTime = await redis.ttl(driver.hash);
    await redis.set(driver.hash, JSON.stringify(data), "EX", expirationTime);
    return false;
  }
}

async function leakyBuckedExceeded(
  driver: LeakyBucketDriver,
  redis: Redis
): Promise<boolean> {
  const BUCKET_SIZE = driver.bucketSize;
  const Fill_RATE: any = driver.fillRate;
  const bucket_count = await redis.get(driver.hash);

  if (!bucket_count) {
    await redis.set(driver.hash, 0);
    return false;
  }
  let bucket_count_number = parseInt(bucket_count);
  bucket_count_number++;
  await redis.set(driver.hash, bucket_count_number);
  if (bucket_count_number > BUCKET_SIZE) {
    return true;
  }

  setTimeout(async () => {
    const bucket_count = await redis.get(driver.hash);
    //@ts-ignore
    let bucket_count_number = parseInt(bucket_count);
    bucket_count_number--;
    await redis.set(driver.hash, bucket_count_number);
  }, 1000 / Fill_RATE);
  return false;
}

export class ExecuteWrapper {
  private readonly successEmitter = new EventEmitter<ISuccessEvent>();
  private readonly failureEmitter = new EventEmitter<IFailureEvent>();
  public readonly onSuccess = this.successEmitter.addListener;
  public readonly onFailure = this.failureEmitter.addListener;

  constructor(
    private readonly errorFilter: (error: Error) => boolean = () => false,
    private readonly resultFilter: (result: unknown) => boolean = () => false
  ) { }

  public clone() {
    return new ExecuteWrapper(this.errorFilter, this.resultFilter);
  }

  public async invoke<T extends unknown[], R>(
    fn: (...args: T) => PromiseLike<R> | R,
    ...args: T
  ): Promise<FailureOrSuccess<R>> {
    try {
      const value = await fn(...args);
      if (!this.resultFilter(value)) {
        return { success: value };
      }

      return { value };
    } catch (rawError) {
      const error = rawError as Error;
      const handled = this.errorFilter(error as Error);

      if (!handled) {
        throw error;
      }

      return { error };
    }
  }
}

export interface ISlidingWindowCounterDriver {
  hash: string;
  maxWindowRequestCount: Number;
  intervalInSeconds: Number;
}

export class SlidingWindowCounterDriver implements ISlidingWindowCounterDriver {
  hash: string;
  maxWindowRequestCount: Number;
  intervalInSeconds: Number;
  constructor(driverOptions: {
    hash: string;
    maxWindowRequestCount: Number;
    intervalInSeconds: Number;
  }) {
    this.hash = driverOptions.hash;
    this.maxWindowRequestCount = driverOptions.maxWindowRequestCount;
    this.intervalInSeconds = driverOptions.intervalInSeconds;
  }
}

export interface ILeakyBucketDriver {
  hash: string;
  bucketSize: Number;
  fillRate: Number;
}

export class LeakyBucketDriver implements ILeakyBucketDriver {
  hash: string;
  bucketSize: Number;
  fillRate: Number;
  constructor(driverOptions: {
    hash: string;
    bucketSize: Number;
    fillRate: Number;
  }) {
    this.hash = driverOptions.hash;
    this.bucketSize = driverOptions.bucketSize;
    this.fillRate = driverOptions.fillRate;
  }
}
