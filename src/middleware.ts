import { BlockList, SocketAddress, isIP, isIPv4, isIPv6 } from 'node:net';
import type { Handler, Middleware, Response } from '@chubbyts/chubbyts-undici-server/dist/server';
import { ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';

/**
 * The (case insensitive) names of the headers the proxies forward the client data within, `for` is the base for the
 * trust decision, the others get only resolved when a client ip was resolved. Each one is optional and replaces its
 * default (`x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host`), `null` disables `proto` and `host`, `for`
 * cannot be disabled.
 */
export type ForwardedHeaders = {
  /** the client ip, e.g. `x-forwarded-for` or `x-real-ip` */
  for?: string;
  /** the scheme the client used, e.g. `x-forwarded-proto`, `null` disables it */
  proto?: string | null;
  /** the host the client requested, e.g. `x-forwarded-host`, `null` disables it */
  host?: string | null;
};

export const DEFAULT_FORWARDED_HEADERS: { for: string; proto: string; host: string } = {
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

type ResolvedForwardedHeaders = { for: string; proto: string | null; host: string | null };

const SCHEMES = new Set(['http', 'https']);

// hostname or ipv4: labels of letters, digits and hyphens (not at the edges), optionally fully qualified
const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/;

// the ipv6 within the brackets gets validated afterwards
const BRACKETED_IPV6_PATTERN = /^\[([0-9A-Fa-f:.]+)\]$/;

// the port suffix of a host, the port gets validated afterwards
const PORT_PATTERN = /:(\d{1,5})$/;

const MIN_PORT = 1;
const MAX_PORT = 65535;

// the canonical form of an ipv4 mapped ipv6 address (`::ffff:203.0.113.1`), which resolves as the ipv4
// Stryker disable next-line Regex: equivalent mutants, the canonical form contains the dotted ipv4 at the end only
const IPV4_MAPPED_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

const NONE = { clientIp: undefined, scheme: undefined, host: undefined };

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
const validHeaderName = (key: keyof ForwardedHeaders, name: unknown): string => {
  if (typeof name !== 'string') {
    throw new TypeError(
      `headers.${key} must be a string${key === 'for' ? '' : ' or null'}, ${name === null ? 'null' : typeof name} given`,
    );
  }

  try {
    new Headers().get(name);
  } catch {
    throw new Error(`headers.${key} must be a valid header name, ${name} given`);
  }

  return name;
};

// a given (not undefined) name replaces the default, `null` disables the header
const resolveOptionalHeaderName = (key: 'proto' | 'host', name: string | null | undefined): string | null => {
  if (name === undefined) {
    return DEFAULT_FORWARDED_HEADERS[key];
  }

  return name === null ? null : validHeaderName(key, name);
};

// `for` cannot be disabled (without it the resolver would silently resolve nothing)
const resolveHeaderNames = (headers: ForwardedHeaders): ResolvedForwardedHeaders => {
  if (typeof headers !== 'object' || headers === null) {
    throw new TypeError(
      `headers must be an object with the keys for, proto and host, ${headers === null ? 'null' : typeof headers} given`,
    );
  }

  // the destructuring default applies to undefined only, null must fail the validation
  const { for: forName = DEFAULT_FORWARDED_HEADERS.for } = headers;

  return {
    for: validHeaderName('for', forName),
    proto: resolveOptionalHeaderName('proto', headers.proto),
    host: resolveOptionalHeaderName('host', headers.host),
  };
};

const entriesOf = (request: ServerRequest, name: string | null): Array<string> => {
  // Stryker disable next-line ConditionalExpression: equivalent mutant, a header named "null" does not exist
  const value = name !== null ? request.headers.get(name) : null;

  // Stryker disable next-line ArrayDeclaration: equivalent mutant, a junk entry is never an ip, scheme or host
  return value ? value.split(',').map((entry) => entry.trim()) : [];
};

// only a valid ip is a client ip, everything else (blank, "unknown", ip:port, zone id, junk) resolves nothing, in its
// canonical form (lowercased, compressed, ipv4 mapped ipv6 addresses as ipv4) so that the same client always
// resolves to the same string
const asIp = (entry: string): string | undefined => {
  // a zone id (`fe80::1%eth0`) is not a valid ip, even though node accepts (and strips) it
  if (!isIP(entry) || entry.includes('%')) {
    return undefined;
  }

  const ip = new SocketAddress({ address: entry, family: isIPv6(entry) ? 'ipv6' : 'ipv4' }).address;

  return IPV4_MAPPED_PATTERN.exec(ip)?.[1] ?? ip;
};

const asScheme = (entry: string | undefined): string | undefined => {
  if (entry === undefined) {
    return undefined;
  }

  const scheme = entry.toLowerCase();

  return SCHEMES.has(scheme) ? scheme : undefined;
};

const asHost = (entry: string | undefined): string | undefined => {
  if (entry === undefined) {
    return undefined;
  }

  const portMatch = PORT_PATTERN.exec(entry);

  if (portMatch !== null && (Number(portMatch[1]) < MIN_PORT || Number(portMatch[1]) > MAX_PORT)) {
    return undefined;
  }

  const host = portMatch === null ? entry : entry.slice(0, portMatch.index);

  const ipv6 = BRACKETED_IPV6_PATTERN.exec(host)?.[1];

  const valid = ipv6 === undefined ? HOSTNAME_PATTERN.test(host) : isIPv6(ipv6);

  // hosts are case insensitive (rfc 3986), so that the same host always resolves to the same string
  return valid ? entry.toLowerCase() : undefined;
};

// strips the port some servers provide the address with (`10.0.0.1:54321`, `[::1]:54321`), everything else stays as
// it is
const withoutPort = (address: string): string => {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):\d+$/.exec(address);

  return match === null ? address : (match[1] ?? match[2]);
};

// the address of the connection, without a port, so that it can be matched against the trusted proxies. Undefined if
// there is none (e.g. a unix socket), a broken (non string) one counts as set: it is returned as an empty string,
// which is never a trusted proxy nor a valid ip, so that it resolves nothing instead of falling back to the headers
const remoteAddressOf = (request: ServerRequest): string | undefined => {
  const { remoteAddress } = request.attributes;

  if (remoteAddress === undefined) {
    return undefined;
  }

  // Stryker disable next-line StringLiteral: equivalent mutant, any non ip string resolves nothing as well
  return typeof remoteAddress === 'string' ? withoutPort(remoteAddress) : '';
};

/**
 * Creates a resolver for the client ip, scheme and host of a request out of the forwarded `headers`:
 *  - the address of the connection (the `remoteAddress` attribute, as set by the server or a middleware in front, a
 *    port gets stripped) anchors the trust: a connection from outside the `trustedProxies` ips / cidrs (e.g.
 *    `['10.0.0.0/8', '::1']`, ipv4 mapped ipv6 addresses match ipv4 subnets) is the client itself, its address is
 *    the client ip and the headers get ignored. An address which is not a valid ip (junk, a non string) resolves
 *    nothing, never a fallback to the headers, as they cannot be trusted without knowing the connection either.
 *    Without any address (`undefined`), nothing gets resolved (fail closed), unless `requireRemoteAddress` is
 *    `false`, in which case the last hop counts as trusted (the server must then not be reachable except through the
 *    proxies).
 *  - the entries of the `for` header get walked from the right (the entries as appended by the proxies, the nearest
 *    one last), skipping the trusted ones, the first untrusted one is the client ip, if it is a valid ip. Only
 *    trusted entries, or an untrusted one which is not a valid ip (blank, `unknown`, `ip:port`, a zone id, junk),
 *    resolve nothing.
 *  - the client ip gets canonicalized (`2001:DB8:0:0::1` as `2001:db8::1`, `::ffff:203.0.113.1` as `203.0.113.1`),
 *    so that the same client always resolves to the same string.
 *  - the scheme and host get only resolved when a client ip was resolved: the entry at the same position, if the
 *    header has as many entries as the `for` header (proxies appending to all of them), the last (the one the nearest
 *    proxy set) otherwise. The scheme gets lowercased and must be `http` or `https`, the host gets lowercased and
 *    must be a syntactically valid host (with an optional port from 1 to 65535), everything else resolves `undefined`.
 */
export const createForwardedResolver = (
  trustedProxies: Array<string>,
  headers: ForwardedHeaders = DEFAULT_FORWARDED_HEADERS,
  requireRemoteAddress = true,
): ForwardedResolver => {
  if (!Array.isArray(trustedProxies)) {
    throw new TypeError(`trustedProxies must be an array of ips or cidrs, ${typeof trustedProxies} given`);
  }

  // an empty list trusts no entry, so the last one (set by the nearest proxy) would resolve as the client ip: reject
  // it, as the middleware makes no sense without a trusted proxy
  if (trustedProxies.length === 0) {
    throw new Error('trustedProxies must not be empty');
  }

  const resolvedHeaders = resolveHeaderNames(headers);

  if (typeof requireRemoteAddress !== 'boolean') {
    throw new TypeError(`requireRemoteAddress must be a boolean, ${typeof requireRemoteAddress} given`);
  }

  const blockList = new BlockList();

  for (const { address, prefix, family } of trustedProxies.map(parseSubnet)) {
    blockList.addSubnet(address, prefix, family);
  }

  // non ip entries are never trusted, the resolver rejects them as client ip afterwards
  const isTrustedProxy = (entry: string): boolean => {
    const ip = asIp(entry);

    return ip !== undefined && blockList.check(ip, isIPv6(ip) ? 'ipv6' : 'ipv4');
  };

  return (request: ServerRequest) => {
    const remoteAddress = remoteAddressOf(request);

    // set but not a trusted proxy: the client connected directly (its address is the client ip), or a broken address
    // which resolves nothing, either way the headers get ignored
    if (remoteAddress !== undefined && !isTrustedProxy(remoteAddress)) {
      return { ...NONE, clientIp: asIp(remoteAddress) };
    }

    if (remoteAddress === undefined && requireRemoteAddress) {
      return { ...NONE };
    }

    const forEntries = entriesOf(request, resolvedHeaders.for);
    const index = forEntries.findLastIndex((entry) => !isTrustedProxy(entry));
    // Stryker disable next-line StringLiteral: equivalent mutant, no replacement for a missing entry (index -1) is an ip
    const clientIp = asIp(forEntries[index] ?? '');

    if (clientIp === undefined) {
      return { ...NONE };
    }

    // equal counts only prove that the proxies append to this header as well as to `for`, not that the entry is
    // trustworthy: a proxy passing this header through untouched lets the client pad it to align the counts, which is
    // why the proxies must set (or strip) all the forwarded headers (see createTrustedProxyMiddleware)
    const alignedEntry = (entries: Array<string>): string | undefined =>
      entries.length === forEntries.length ? entries[index] : entries.at(-1);

    return {
      clientIp,
      scheme: asScheme(alignedEntry(entriesOf(request, resolvedHeaders.proto))),
      host: asHost(alignedEntry(entriesOf(request, resolvedHeaders.host))),
    };
  };
};

/**
 * Passes the request on with the values of the `forwardedResolver` as `clientIp`, `scheme` and `host` attributes
 * (the unresolved ones as `undefined`, so that nothing set before the middleware survives, no matter if resolved or
 * not).
 *
 * Mind that the middleware only sees the headers and the `remoteAddress` attribute (if the server provides it), so
 * the proxies must set (or strip) all the forwarded headers, as any header they do not touch is supplied by the
 * client.
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
