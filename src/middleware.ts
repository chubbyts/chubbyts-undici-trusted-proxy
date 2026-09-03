import { BlockList, SocketAddress, isIP, isIPv4, isIPv6 } from 'node:net';
import type { Handler, Middleware, Response } from '@chubbyts/chubbyts-undici-server/dist/server';
import { ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';

/**
 * The (case insensitive) names of the headers the proxies forward the client data within, `for` is the base for the
 * trust decision, the others get only resolved when a client ip was resolved.
 */
export type ForwardedHeaders = {
  /** the client ip, e.g. `x-forwarded-for` or `x-real-ip` */
  for: string;
  /** the scheme the client used, e.g. `x-forwarded-proto` */
  proto?: string;
  /** the host the client requested, e.g. `x-forwarded-host` */
  host?: string;
};

export const DEFAULT_FORWARDED_HEADERS: ForwardedHeaders = {
  for: 'x-forwarded-for',
  proto: 'x-forwarded-proto',
  host: 'x-forwarded-host',
};

/**
 * The request attributes the middleware sets, the unresolved ones as `undefined` (each `string | undefined` on the request).
 */
export type TrustedProxyAttributes = {
  clientIp: string;
  scheme: string;
  host: string;
};

/**
 * Resolves the client data of a request out of the forwarded headers, every value not resolvable is `undefined`
 * (always all keys, so that the middleware overwrites whatever was set before it).
 */
export type ForwardedResolver = (request: ServerRequest) => {
  [K in keyof TrustedProxyAttributes]: TrustedProxyAttributes[K] | undefined;
};

const parseSubnet = (subnet: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } => {
  // trimmed, as config often comes out of env vars
  const [address, prefix, ...rest] = subnet.trim().split('/');

  if (rest.length > 0 || (!isIPv4(address) && !isIPv6(address))) {
    throw new Error(`trustedProxies must contain valid ips or cidrs, ${subnet} given`);
  }

  const family = isIPv4(address) ? 'ipv4' : 'ipv6';

  const maxPrefix = family === 'ipv4' ? 32 : 128;
  const parsedPrefix = prefix === undefined ? maxPrefix : Number(prefix);

  if ((prefix !== undefined && !/^\d+$/.test(prefix)) || parsedPrefix > maxPrefix) {
    throw new Error(`trustedProxies must contain valid ips or cidrs, ${subnet} given`);
  }

  if (parsedPrefix === 0) {
    throw new Error(`trustedProxies must not contain a subnet matching every ip, ${subnet} given`);
  }

  return { address, prefix: parsedPrefix, family };
};

// fail fast at creation instead of per request within Headers.get, which stringifies anything (`undefined` is a valid
// header name), so the type needs its own check
const validateHeaderName = (key: keyof ForwardedHeaders, name: unknown): void => {
  if (typeof name !== 'string') {
    throw new TypeError(`headers.${key} must be a string, ${typeof name} given`);
  }

  try {
    new Headers().get(name);
  } catch {
    throw new Error(`headers.${key} must be a valid header name, ${name} given`);
  }
};

// `for` is required (without it the resolver would silently resolve nothing), the others are optional
const validateHeaderNames = (headers: ForwardedHeaders): void => {
  validateHeaderName('for', headers.for);

  if (headers.proto !== undefined) {
    validateHeaderName('proto', headers.proto);
  }

  if (headers.host !== undefined) {
    validateHeaderName('host', headers.host);
  }
};

const entriesOf = (request: ServerRequest, name: string | undefined): Array<string> => {
  // Stryker disable next-line ConditionalExpression: equivalent mutant, a header named "undefined" does not exist
  const value = name !== undefined ? request.headers.get(name) : null;

  return value ? value.split(',').map((entry) => entry.trim()) : [];
};

const nonBlank = (entry: string | undefined): string | undefined => entry || undefined;

// only a valid ip is a client ip, everything else (blank, "unknown", ip:port, junk, a non string) resolves nothing,
// in its canonical form (lowercased, compressed, without zone id) so that downstream comparisons work
const asIp = (entry: unknown): string | undefined =>
  typeof entry === 'string' && isIP(entry)
    ? new SocketAddress({ address: entry, family: isIPv6(entry) ? 'ipv6' : 'ipv4' }).address
    : undefined;

/**
 * Creates a resolver for the client ip, scheme and host of a request out of the forwarded `headers`:
 *  - the entries of the `for` header get walked from the right (the entries as appended by the proxies, the nearest
 *    one last), skipping the ones within the `trustedProxies` ips / cidrs (e.g. `['10.0.0.0/8', '::1']`, ipv4 mapped
 *    ipv6 addresses match ipv4 subnets), the first untrusted one is the client ip, if it is a valid ip (returned in
 *    its canonical form: lowercased, compressed, without zone id). Only trusted entries, or an untrusted one which is
 *    not a valid ip (blank, `unknown`, `ip:port`, junk), resolve nothing.
 *  - the scheme and host get only resolved when a client ip was resolved: the entry at the same position, if the
 *    header has as many entries as the `for` header (proxies appending to all of them), the last (the one the nearest
 *    proxy set) otherwise. The scheme gets lowercased.
 *  - if the request has a `remoteAddress` attribute (the address of the connection, as set by the server), a
 *    connection from outside the trusted ranges is the client itself: its address is the client ip and the headers get
 *    ignored. An attribute which is not a valid ip (junk, a non string) resolves nothing, as the headers cannot be
 *    trusted without knowing the connection either.
 */
export const createForwardedResolver = (
  trustedProxies: Array<string>,
  headers: ForwardedHeaders = DEFAULT_FORWARDED_HEADERS,
): ForwardedResolver => {
  if (!Array.isArray(trustedProxies)) {
    throw new TypeError(`trustedProxies must be an array of ips or cidrs, ${typeof trustedProxies} given`);
  }

  // an empty list trusts no entry, so the last one (set by the nearest proxy) would resolve as the client ip: reject
  // it, as the middleware makes no sense without a trusted proxy
  if (trustedProxies.length === 0) {
    throw new Error('trustedProxies must not be empty');
  }

  validateHeaderNames(headers);

  const blockList = new BlockList();

  for (const { address, prefix, family } of trustedProxies.map(parseSubnet)) {
    blockList.addSubnet(address, prefix, family);
  }

  // non ip entries are never trusted (check returns false), the resolver rejects them as client ip afterwards
  const isTrustedProxy = (ip: string): boolean => blockList.check(ip, isIPv6(ip) ? 'ipv6' : 'ipv4');

  return (request: ServerRequest) => {
    const { remoteAddress } = request.attributes;

    // set (undefined counts as not set, e.g. a unix socket) but not a trusted proxy: the client itself, or a broken
    // (non ip, non string) attribute which resolves nothing, never a fallback to the headers
    if (remoteAddress !== undefined && (typeof remoteAddress !== 'string' || !isTrustedProxy(remoteAddress))) {
      return { clientIp: asIp(remoteAddress), scheme: undefined, host: undefined };
    }

    const forEntries = entriesOf(request, headers.for);
    const index = forEntries.findLastIndex((entry) => !isTrustedProxy(entry));
    // Stryker disable next-line StringLiteral: equivalent mutant, no replacement for a missing entry (index -1) is an ip
    const clientIp = asIp(forEntries[index] ?? '');

    if (clientIp === undefined) {
      return { clientIp: undefined, scheme: undefined, host: undefined };
    }

    // equal counts only prove that the proxies append to this header as well as to `for`, not that the entry is
    // trustworthy: a proxy passing this header through untouched lets the client pad it to align the counts, which is
    // why the proxies must set (or strip) all the forwarded headers (see createTrustedProxyMiddleware)
    const resolveAligned = (entries: Array<string>): string | undefined =>
      nonBlank(entries.length === forEntries.length ? entries[index] : entries.at(-1));

    return {
      clientIp,
      scheme: resolveAligned(entriesOf(request, headers.proto))?.toLowerCase(),
      host: resolveAligned(entriesOf(request, headers.host)),
    };
  };
};

/**
 * Passes the request on with the values of the `forwardedResolver` as `clientIp`, `scheme` and `host` attributes
 * (the unresolved ones as `undefined`, so that nothing set before the middleware survives, no matter if resolved or
 * not).
 *
 * Mind that the middleware only sees the headers (and the `remoteAddress` attribute if the server provides it), so
 * the server must not be reachable except through the proxies, and the proxies must set (or strip) all the forwarded
 * headers, as any header they do not touch is supplied by the client.
 */
export const createTrustedProxyMiddleware = (
  forwardedResolver: ForwardedResolver,
): Middleware<TrustedProxyAttributes> => {
  return async (
    request: ServerRequest<TrustedProxyAttributes>,
    handler: Handler<TrustedProxyAttributes>,
  ): Promise<Response> => {
    return handler(new ServerRequest(request, { attributes: forwardedResolver(request) }));
  };
};
