<div align="center">
<h3 align="center">Resilience</h3>

  <p align="center">
    Resilience is built on [Cockatiel](https://github.com/connor4312/cockatiel) with redis.
  </p>
</div>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#contributing">Contributing</a></li>
  </ol>
</details>

## About The Project

An enhancement to a circuit breaker with a rate limiter to protect your application from overloading due to excessive requests. The breaker can be used to stop sending requests to a service that is failing or is overloaded together with the rate limiter that limits the number of requests that can be made within a certain time period. Together, circuit breaker and rate limiter can help prevent your application from crashing or becoming unresponsive due to too many requests.

<p align="right">(<a href="#top">back to top</a>)</p>

### Built With

This project is built on the top of cockatiel.

* [Cockatiel](https://github.com/connor4312/cockatiel)

<p align="right">(<a href="#top">back to top</a>)</p>

<!-- GETTING STARTED -->

## Getting Started

You should have a basic setup of nodejs project using typescript

### Prerequisites

Should have a sound knowledge of Circuit Breaker, Rate Limiter and typescript. Redis should be installed on your machine

### Installation

1. Install redis sampling breaker package
   ```sh
   npm i @carbonteq/resilience
   ```
<p align="right">(<a href="#top">back to top</a>)</p>

## Usage

Then go forth with sampling breaker:

```js
import {
  ExponentialBackoff,
  retry,
  handleAll,
  circuitBreaker,
  wrap,
  RedisSamplingBreaker
} from '@carbonteq/resilience';
import axios from "axios";
import Redis from "ioredis";

// Create a retry policy that'll try whatever function we execute 3
// times with a randomized exponential backoff.
const retry = retry(handleAll, { maxAttempts: 3, backoff: new ExponentialBackoff() });

// Create a circuit breaker that'll stop calling the executed function for 10
// seconds if it fails 5 times in a row. This can give time for e.g. a database
// to recover without getting tons of traffic.
const circuitBreakerPolicy = circuitBreaker(handleAll, {
  halfOpenAfter: 10 * 1000,
  breaker: new RedisSamplingBreaker({ threshold: 0.2, duration: 30 * 1000, redisClient: new Redis() }),
});

// Combine these! Create a policy that retries 3 times, calling through the circuit breaker
const retryWithBreaker = wrap(retry, circuitBreakerPolicy);

exports.handleRequest = async (req, res) => {
  const data = await retryWithBreaker.execute(() => axios.get("http://127.0.0.1:8080"));
  return res.json(data);
};
```


With rate limiting policy and sliding window counter driver:

```js
import * as crypto from "crypto"
import axios from "axios";
import Redis from "ioredis";
import {handleAll, rateLimiter,SlidingWindowCounterDriver } from "@carbonteq/resilience";

exports.handleRequest = async (req, res) => {
  const hash = crypto.createHash("md5").update(req.ip).digest("hex");
  const rateLimiterPolicy = rateLimiter(handleAll, {
    redisClient: new Redis(),
    driver: new SlidingWindowCounterDriver({
      hash: hash,
      maxWindowRequestCount: 5,
      intervalInSeconds: 1 * 60,
    }),
  });

  const data = await rateLimiterPolicy.execute(() => axios.get("http://127.0.0.1:8080"));
  return res.json(data);
};
```

With rate limiting policy and leaky bucket driver:

```js
import * as crypto from "crypto"
import axios from "axios";
import Redis from "ioredis";
import { handleAll, rateLimiter,LeakyBucketDriver } from "@carbonteq/resilience";

exports.handleRequest = async (req, res) => {
  const hash = crypto.createHash("md5").update(req.ip).digest("hex");
  const rateLimiterPolicy = rateLimiter(handleAll, {
    redisClient: new Redis(),
    driver: new LeakyBucketDriver({
      hash: hash,
      bucketSize: 5,
      fillRate: 10,
    }),
  });

  const data = await rateLimiterPolicy.execute(() => axios.get("http://127.0.0.1:8080"));
  return res.json(data);
};
```

Wrap both rate limiting and sampling breaker:

```js
import * as crypto from "crypto"
import {
  handleAll,
  retry,
  circuitBreaker,
  rateLimiter,
  RedisSamplingBreaker,
  SlidingWindowCounterDriver
} from '@carbonteq/resilience';
import axios from "axios";
import Redis from "ioredis";

const circuitBreakerPolicy = circuitBreaker(handleAll, {
  halfOpenAfter: 10 * 1000,
  breaker: new SamplingBreaker({ threshold: 0.2, duration: 30 * 1000,redisClient: new Redis() }),
});

const retryPolicy = retry(handleAll, {
  maxAttempts: 3,
  backoff: new ExponentialBackoff(),
});
exports.handleRequest = async (req, res) => {
    const hash = crypto.createHash("md5").update(req.ip).digest("hex");
    const rateLimiterPolicy = rateLimiter(handleAll, {
      redisClient: new Redis(),
      driver: new SlidingWindowCounterDriver({
        hash: hash,
        maxWindowRequestCount: 5,
        intervalInSeconds: 1 * 60,
      }),
    });

  
  const retryWithBreaker = wrap(redisRateLimiterPolicy,retryPolicy,circuitBreakerPolicy);
  const data = await retryWithBreaker.execute(() => axios.get("http://127.0.0.1:8080"));
  return res.json(data);
};
```


<p align="right">(<a href="#top">back to top</a>)</p>

## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any
contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also
simply open an issue with the tag "enhancement". Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#top">back to top</a>)</p>