import { expect, use } from "chai";
import Redis from "ioredis-mock";
import { handleAll } from "./Policy";
import { LeakyBucketDriver, rateLimiter, SlidingWindowCounterDriver } from "./RateLimiterPolicy";
use(require('sinon-chai'));
use(require("chai-as-promised"));

afterEach(done => {
  new Redis().flushall().then(() => done())
})

describe("Rate limiting policy with Sliding WIndow Counter", () => {
  it("It should execute", async () => {
    const rateLimiterPolicy = rateLimiter(handleAll, {
      redisClient: new Redis(),
      driver: new SlidingWindowCounterDriver({
        hash: "abc",
        maxWindowRequestCount: 5,
        intervalInSeconds: 1 * 60,
      }),
    });
    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
  });

  it("It should throw an Error after 5 number of executions", async () => {
    const rateLimiterPolicy = rateLimiter(handleAll, {
      redisClient: new Redis(),
      driver: new SlidingWindowCounterDriver({
        hash: "abc",
        maxWindowRequestCount: 5,
        intervalInSeconds: 1 * 60,
      }),
    });

    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
    try {
      await rateLimiterPolicy.execute(() => 42);
    } catch (e: any) {
      expect(e.message).to.equal('Rate Limit Exceded')
    }
  });
});


describe("Rate limiting with Leaky Bucket", () => {
  it("It should execute", async () => {
    const rateLimiterPolicy = rateLimiter(handleAll, {
      redisClient: new Redis(),
      driver: new LeakyBucketDriver({
        hash: 'abc',
        bucketSize: 5,
        fillRate: 10,
      }),
    });
    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
  });

  it("It should throw an Error", async () => {
    const rateLimiterPolicy = rateLimiter(handleAll, {
      redisClient: new Redis(),
      driver: new LeakyBucketDriver({
        hash: 'abc',
        bucketSize: 5,
        fillRate: 10,
      }),
    });

    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
    expect(await rateLimiterPolicy.execute(() => 42)).to.equal(42);
    try {
      await rateLimiterPolicy.execute(() => 42);
    } catch (e: any) {
      expect(e.message).to.equal('Rate Limit Exceded')
    }
  });
});
