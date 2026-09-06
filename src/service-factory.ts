import type { Container } from '@chubbyts/chubbyts-dic-types/dist/container';
import { createAbstractFactory } from '@chubbyts/chubbyts-dic-config-factory/dist/dic-config-factory';
import type { Middleware } from '@chubbyts/chubbyts-undici-server/dist/server';
import type { ForwardedHeaders, ForwardedResolver, TrustedProxyAttributes } from './middleware.js';
import { createForwardedResolver, createTrustedProxyMiddleware } from './middleware.js';

/**
 * The configuration read by the service factories from `config.chubbyts.trustedProxy` (or
 * `config.chubbyts.trustedProxy.<name>` for named factories), see the arguments of `createForwardedResolver`.
 */
export type TrustedProxyConfig = {
  /** the ips / cidrs of the proxies */
  trustedProxies: Array<string>;
  /** the forwarded header names (`for`, `proto`, `host`), each one replaces its default, `null` disables `proto` and `host` */
  headers?: ForwardedHeaders;
  /** resolve nothing if the request carries no address of the connection (default `true`) */
  requireRemoteAddress?: boolean;
};

type Config = {
  chubbyts: {
    trustedProxy: TrustedProxyConfig | Record<string, TrustedProxyConfig>;
  };
};

const HEADER_KEYS = new Set(['for', 'proto', 'host']);

const typeOf = (value: unknown): string => (value === null ? 'null' : typeof value);

// the whole shape gets checked here (with the config path), so that createForwardedResolver only throws for values
const validateHeaders = (path: string, headers: unknown): void => {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new TypeError(
      `${path}.headers must be an object with the keys for, proto and host, ${typeOf(headers)} given`,
    );
  }

  for (const [key, name] of Object.entries(headers)) {
    if (!HEADER_KEYS.has(key)) {
      throw new TypeError(`${path}.headers must be an object with the keys for, proto and host, key ${key} given`);
    }

    if (typeof name !== 'string' && (key === 'for' || name !== null)) {
      throw new TypeError(
        `${path}.headers.${key} must be a ${key === 'for' ? 'string' : 'string or null'}, ${typeOf(name)} given`,
      );
    }
  }
};

export const forwardedResolverServiceFactory = createAbstractFactory(
  (container: Container, { name, resolveConfig }): ForwardedResolver => {
    const suffix = name ? `.${name}` : '';
    const path = `config.chubbyts.trustedProxy${suffix}`;
    const {
      trustedProxies,
      headers = {},
      requireRemoteAddress = true,
    } = resolveConfig(container.get<Partial<Config>>('config').chubbyts?.trustedProxy ?? {}) as Record<
      keyof TrustedProxyConfig,
      unknown
    >;

    if (!Array.isArray(trustedProxies)) {
      throw new TypeError(`${path}.trustedProxies must be an array of ips or cidrs, ${typeOf(trustedProxies)} given`);
    }

    validateHeaders(path, headers);

    if (typeof requireRemoteAddress !== 'boolean') {
      throw new TypeError(`${path}.requireRemoteAddress must be a boolean, ${typeOf(requireRemoteAddress)} given`);
    }

    try {
      return createForwardedResolver(trustedProxies, headers as ForwardedHeaders, requireRemoteAddress);
    } catch (e) {
      // the messages start with the key (`trustedProxies ...`, `headers.for ...`), so the path gets prepended
      throw new Error(`${path}.${(e as Error).message}`, { cause: e });
    }
  },
);

export const trustedProxyMiddlewareServiceFactory = createAbstractFactory(
  (container: Container, { resolveDependency }): Middleware<TrustedProxyAttributes> =>
    // a registered service wins over the shipped factory, so that the resolver can be replaced or shared
    createTrustedProxyMiddleware(
      resolveDependency(container, 'trustedProxyForwardedResolver', forwardedResolverServiceFactory),
    ),
);
