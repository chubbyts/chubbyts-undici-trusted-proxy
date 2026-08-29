import type { Container } from '@chubbyts/chubbyts-dic-types/dist/container';
import { createAbstractFactory } from '@chubbyts/chubbyts-dic-config-factory/dist/dic-config-factory';
import type { Middleware } from '@chubbyts/chubbyts-undici-server/dist/server';
import type { ForwardedHeaders, ForwardedResolver, TrustedProxyAttributes } from './middleware.js';
import { DEFAULT_FORWARDED_HEADERS, createForwardedResolver, createTrustedProxyMiddleware } from './middleware.js';

/**
 * The configuration read by the service factories from `config.chubbyts.trustedProxy` (or
 * `config.chubbyts.trustedProxy.<name>` for named factories), see the arguments of `createForwardedResolver`.
 */
export type TrustedProxyConfig = {
  /** the ips / cidrs of the proxies */
  trustedProxies: Array<string>;
  /** the forwarded header names, replaces the defaults (`x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host`) */
  headers?: ForwardedHeaders;
};

type Config = {
  chubbyts: {
    trustedProxy: TrustedProxyConfig | Record<string, TrustedProxyConfig>;
  };
};

export const forwardedResolverServiceFactory = createAbstractFactory(
  (container: Container, { name, resolveConfig }): ForwardedResolver => {
    const suffix = name ? `.${name}` : '';
    const path = `config.chubbyts.trustedProxy${suffix}`;
    const { trustedProxies, headers = DEFAULT_FORWARDED_HEADERS } = resolveConfig(
      container.get<Partial<Config>>('config').chubbyts?.trustedProxy ?? {},
    ) as Partial<TrustedProxyConfig>;

    if (!Array.isArray(trustedProxies)) {
      throw new TypeError(`${path}.trustedProxies must be an array of ips or cidrs, ${typeof trustedProxies} given`);
    }

    return createForwardedResolver(trustedProxies, headers);
  },
);

export const trustedProxyMiddlewareServiceFactory = createAbstractFactory(
  (container: Container, { resolveDependency }): Middleware<TrustedProxyAttributes> =>
    // a registered service wins over the shipped factory, so that the resolver can be replaced or shared
    createTrustedProxyMiddleware(
      resolveDependency(container, 'trustedProxyForwardedResolver', forwardedResolverServiceFactory),
    ),
);
