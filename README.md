# chubbyts-undici-trusted-proxy

[![CI](https://github.com/chubbyts/chubbyts-undici-trusted-proxy/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/chubbyts/chubbyts-undici-trusted-proxy/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/chubbyts/chubbyts-undici-trusted-proxy/badge.svg?branch=master)](https://coveralls.io/github/chubbyts/chubbyts-undici-trusted-proxy?branch=master)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fchubbyts%2Fchubbyts-undici-trusted-proxy%2Fmaster)](https://dashboard.stryker-mutator.io/reports/github.com/chubbyts/chubbyts-undici-trusted-proxy/master)
[![npm-version](https://img.shields.io/npm/v/@chubbyts/chubbyts-undici-trusted-proxy.svg)](https://www.npmjs.com/package/@chubbyts/chubbyts-undici-trusted-proxy)

[![bugs](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=bugs)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)
[![code_smells](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=code_smells)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)
[![coverage](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=coverage)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)
[![duplicated_lines_density](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=duplicated_lines_density)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)
[![ncloc](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=ncloc)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)
[![sqale_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=sqale_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)
[![alert_status](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=alert_status)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)
[![reliability_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=reliability_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)
[![security_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=security_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)
[![sqale_index](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=sqale_index)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)
[![vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-trusted-proxy&metric=vulnerabilities)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-trusted-proxy)

## Description

A trusted proxy middleware for chubbyts-undici-server: resolves the client ip, scheme and host from the forwarded
headers (`x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host`) of trusted proxies into request attributes.

## Requirements

 * node: 22
 * [@chubbyts/chubbyts-dic-config-factory][5]: ^1.0.0
 * [@chubbyts/chubbyts-dic-types][3]: ^2.3.0
 * [@chubbyts/chubbyts-undici-server][2]: ^1.2.0

## Installation

Through [NPM](https://www.npmjs.com) as [@chubbyts/chubbyts-undici-trusted-proxy][1].

```ts
npm i @chubbyts/chubbyts-undici-trusted-proxy@^1.0.0
```

## Usage

Behind a reverse proxy (nginx, traefik, a load balancer, ...) the server only sees the proxy, the client data arrives
within the forwarded headers, which any client can send as well. The middleware decides which entries of these headers
to trust and passes the request on with the `clientIp`, `scheme` and `host` attributes set, so that every other part
(rate limiting, logging, access control, url generation, ...) reads them from one place instead of parsing headers.

```ts
import type { TrustedProxyAttributes } from '@chubbyts/chubbyts-undici-trusted-proxy/dist/middleware';
import { createForwardedResolver, createTrustedProxyMiddleware } from '@chubbyts/chubbyts-undici-trusted-proxy/dist/middleware';
import type { Handler } from '@chubbyts/chubbyts-undici-server/dist/server';
import { Response, ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';

// the ips / cidrs of the proxies: the entries of x-forwarded-for get walked from the right, the first one not within
// the ranges is the client (robust against a varying number of hops)
const trustedProxyMiddleware = createTrustedProxyMiddleware(createForwardedResolver(['10.0.0.0/8', '::1']));

const handler: Handler<TrustedProxyAttributes> = async (serverRequest) => {
  // each one string | undefined: the unresolved ones are undefined
  const { clientIp, scheme, host } = serverRequest.attributes;

  return new Response(`${clientIp} requested ${scheme}://${host}`);
};

(async () => {
  const serverRequest = new ServerRequest<TrustedProxyAttributes>('https://example.com', {
    headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com' },
  });

  const response = await trustedProxyMiddleware(serverRequest, handler);
})();
```

Register the middleware **before** any middleware that reads the attributes. Requests without a resolvable client ip
(no `x-forwarded-for`, only trusted entries, or a first untrusted entry which is not a valid ip like `unknown` or
`ip:port`) get `undefined` attributes. The middleware always sets all three attributes (the unresolved ones as
`undefined`), so that nothing set before it survives. A subnet matching every ip (`0.0.0.0/0`, `::/0`) gets rejected, as it would
trust every entry and never resolve anything, an empty list as well, as it would trust no entry and resolve the nearest
proxy as client ip, the entries get trimmed.

The scheme and host get only resolved when a client ip was resolved: the entry at the same position, if the header has
as many entries as the `x-forwarded-for` header (proxies appending to all of them), the last (the one the nearest proxy
set) otherwise. The scheme gets lowercased.

### Security

The middleware only sees the headers, not the connection: it cannot verify that the last hop actually was a trusted
proxy. The server must not be reachable except through the proxies, and the proxies must set (or strip) all the
forwarded headers, as any header they do not touch is supplied by the client.

If the server (or a middleware in front) sets the address of the connection as `remoteAddress` attribute, the
middleware uses it: a connection from outside the trusted ranges counts as the client itself, and the headers get
ignored.

The `clientIp` is always a valid ip, the `scheme` and `host` get taken from the headers as sent by the proxies (the
scheme only lowercased): before using them for url generation or redirects, check the `scheme` against `http` /
`https` and the `host` against the hosts the application serves (an allowlist), so that a proxy passing the client's
`x-forwarded-proto` / `x-forwarded-host` through cannot poison generated urls:

```ts
const { scheme, host } = serverRequest.attributes;

if ((scheme !== 'http' && scheme !== 'https') || !['example.com', 'www.example.com'].includes(host ?? '')) {
  return new Response('Bad Request', { status: 400 });
}
```

### Headers

The second argument replaces the header names (`for` is required, the others are optional), useful for a proxy setting
a single value header like `x-real-ip`:

```ts
createForwardedResolver(['10.0.0.0/8'], { for: 'x-real-ip', proto: 'x-forwarded-proto' });
```

### Service factories (chubbyts-dic-config)

The package ships service factories (abstract factories built on [chubbyts-dic-config-factory][5]) for a [chubbyts-dic-config][4] (or any [chubbyts-dic-types][3] compatible) container within `@chubbyts/chubbyts-undici-trusted-proxy/dist/service-factory`, configured through `config.chubbyts.trustedProxy`:

```ts
import type { ConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import { createContainerByConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import type { TrustedProxyAttributes } from '@chubbyts/chubbyts-undici-trusted-proxy/dist/middleware';
import type { TrustedProxyConfig } from '@chubbyts/chubbyts-undici-trusted-proxy/dist/service-factory';
import { trustedProxyMiddlewareServiceFactory } from '@chubbyts/chubbyts-undici-trusted-proxy/dist/service-factory';
import type { Middleware } from '@chubbyts/chubbyts-undici-server/dist/server';

const container = createContainerByConfigFactory({
  chubbyts: {
    trustedProxy: {
      trustedProxies: ['10.0.0.0/8', '::1'],
      // headers: { for: 'x-forwarded-for', proto: 'x-forwarded-proto', host: 'x-forwarded-host' },
    } satisfies TrustedProxyConfig,
  },
  dependencies: {
    factories: new Map<string, ConfigFactory>([['trustedProxyMiddleware', trustedProxyMiddlewareServiceFactory()]]),
  },
})();

const trustedProxyMiddleware = container.get<Middleware<TrustedProxyAttributes>>('trustedProxyMiddleware');
```

The `trustedProxyMiddlewareServiceFactory` uses the service `trustedProxyForwardedResolver` of the container if registered, and creates it through the shipped `forwardedResolverServiceFactory` otherwise. Register it under its name to replace it or to share it with other services.

#### With names

To serve different parts of an application behind different proxies (a public load balancer, an internal one, ...), the same factories can be registered multiple times with a name: the config is then read from `config.chubbyts.trustedProxy.<name>` and the name gets appended to each service id (`trustedProxyMiddlewarepublic`, `trustedProxyForwardedResolverpublic`, ...).

```ts
const container = createContainerByConfigFactory({
  chubbyts: {
    trustedProxy: {
      public: { trustedProxies: ['10.0.0.0/8', '::1'] },
      internal: { trustedProxies: ['192.168.0.0/16'], headers: { for: 'x-real-ip', proto: 'x-forwarded-proto' } },
    } satisfies Record<string, TrustedProxyConfig>,
  },
  dependencies: {
    factories: new Map<string, ConfigFactory>([
      ['trustedProxyMiddlewarepublic', trustedProxyMiddlewareServiceFactory('public')],
      ['trustedProxyMiddlewareinternal', trustedProxyMiddlewareServiceFactory('internal')],
    ]),
  },
})();

const publicTrustedProxyMiddleware = container.get<Middleware<TrustedProxyAttributes>>('trustedProxyMiddlewarepublic');
const internalTrustedProxyMiddleware = container.get<Middleware<TrustedProxyAttributes>>('trustedProxyMiddlewareinternal');
```

## Copyright

2026 Dominik Zogg

[1]: https://www.npmjs.com/package/@chubbyts/chubbyts-undici-trusted-proxy
[2]: https://www.npmjs.com/package/@chubbyts/chubbyts-undici-server
[3]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-types
[4]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-config
[5]: https://www.npmjs.com/package/@chubbyts/chubbyts-dic-config-factory
