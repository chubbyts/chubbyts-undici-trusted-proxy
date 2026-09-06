import { describe, expect, test } from 'vitest';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/dist/function-mock';
import type { Handler } from '@chubbyts/chubbyts-undici-server/dist/server';
import { Response, ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';
import type { ForwardedHeaders, ForwardedResolver, TrustedProxyAttributes } from '../src/middleware';
import { DEFAULT_FORWARDED_HEADERS, createForwardedResolver, createTrustedProxyMiddleware } from '../src/middleware';

const none = { clientIp: undefined, scheme: undefined, host: undefined };
const ip = (clientIp: string) => ({ ...none, clientIp });

const createRequest = (headers: Record<string, string> = {}, attributes: Record<string, unknown> = {}) =>
  new ServerRequest<TrustedProxyAttributes, Record<string, unknown>>('https://api.example.com/resource', {
    headers,
    attributes,
  });

// the header resolution gets tested without the address of the connection (the mode for servers not providing it),
// the anchoring at the address gets its own tests
const createHeadersOnlyResolver = (trustedProxies: Array<string>, headers?: ForwardedHeaders) =>
  createForwardedResolver(trustedProxies, headers, false);

describe('middleware', () => {
  describe('createForwardedResolver', () => {
    test('with invalid trusted proxies', () => {
      for (const subnet of [
        'not-an-ip',
        '10.0.0.0/33',
        'fd00::/129',
        '10.0.0.0/',
        '10.0.0.0/-1',
        '10.0.0.0/8x',
        '10.0.0.0/8/1',
      ]) {
        expect(() => createForwardedResolver(['10.0.0.0/8', subnet])).toThrow(
          `trustedProxies must contain valid ips or cidrs, ${subnet} given`,
        );
      }

      for (const subnet of ['0.0.0.0/0', '::/0']) {
        expect(() => createForwardedResolver(['10.0.0.0/8', subnet])).toThrow(
          `trustedProxies must not contain a subnet matching every ip, ${subnet} given`,
        );
      }

      expect(() => createForwardedResolver('10.0.0.0/8' as unknown as Array<string>)).toThrow(
        new TypeError('trustedProxies must be an array of ips or cidrs, string given'),
      );

      expect(() => createForwardedResolver([])).toThrow('trustedProxies must not be empty');
    });

    test('with invalid headers', () => {
      expect(() => createForwardedResolver(['10.0.0.0/8'], 'x-real-ip' as unknown as ForwardedHeaders)).toThrow(
        new TypeError('headers must be an object with the keys for, proto and host, string given'),
      );
      expect(() => createForwardedResolver(['10.0.0.0/8'], null as unknown as ForwardedHeaders)).toThrow(
        new TypeError('headers must be an object with the keys for, proto and host, null given'),
      );
      expect(() => createForwardedResolver(['10.0.0.0/8'], { for: null as unknown as string })).toThrow(
        new TypeError('headers.for must be a string, null given'),
      );
      expect(() => createForwardedResolver(['10.0.0.0/8'], { for: 1 as unknown as string })).toThrow(
        new TypeError('headers.for must be a string, number given'),
      );
      expect(() => createForwardedResolver(['10.0.0.0/8'], { proto: 1 as unknown as string })).toThrow(
        new TypeError('headers.proto must be a string or null, number given'),
      );
      expect(() => createForwardedResolver(['10.0.0.0/8'], { for: 'bad header name' })).toThrow(
        'headers.for must be a valid header name, bad header name given',
      );
      expect(() => createForwardedResolver(['10.0.0.0/8'], { host: '' })).toThrow(
        'headers.host must be a valid header name,  given',
      );
    });

    test('with invalid requireRemoteAddress', () => {
      expect(() =>
        createForwardedResolver(['10.0.0.0/8'], DEFAULT_FORWARDED_HEADERS, 'yes' as unknown as boolean),
      ).toThrow(new TypeError('requireRemoteAddress must be a boolean, string given'));
    });

    test('with partial headers, the given ones replace their defaults', () => {
      const request = createRequest({
        'x-forwarded-for': 'spoofed',
        'x-real-ip': '203.0.113.1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'example.com',
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'], { for: 'x-real-ip' })(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: 'example.com',
      });
      expect(createHeadersOnlyResolver(['10.0.0.0/8'], { for: 'x-real-ip', proto: undefined })(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: 'example.com',
      });
      expect(createHeadersOnlyResolver(['10.0.0.0/8'], {})(request)).toStrictEqual(none);
    });

    test('with null headers, proto and host get disabled', () => {
      const request = createRequest({
        'x-forwarded-for': '203.0.113.1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'example.com',
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'], { proto: null })(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: undefined,
        host: 'example.com',
      });
      expect(createHeadersOnlyResolver(['10.0.0.0/8'], { proto: null, host: null })(request)).toStrictEqual(
        ip('203.0.113.1'),
      );
    });

    test('with untrimmed trusted proxies', () => {
      expect(
        createHeadersOnlyResolver([' 10.0.0.0/8 ', '::1\n'])(
          createRequest({ 'x-forwarded-for': '203.0.113.1, ::1, 10.0.0.1' }),
        ),
      ).toStrictEqual(ip('203.0.113.1'));
    });

    test('without headers', () => {
      expect(createHeadersOnlyResolver(['10.0.0.0/8'])(createRequest())).toStrictEqual(none);
    });

    test('without for header, the other headers get ignored', () => {
      expect(
        createHeadersOnlyResolver(['10.0.0.0/8'])(
          createRequest({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com' }),
        ),
      ).toStrictEqual(none);
    });

    test('with empty or blank for entries', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      expect(resolve(createRequest({ 'x-forwarded-for': '' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': ',,' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1, ' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': ' , 10.0.0.1' }))).toStrictEqual(none);
    });

    test('with ips and cidrs, the first untrusted entry from the right', () => {
      const resolve = createHeadersOnlyResolver([
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.1.1',
        'fd00::/8',
        '2001:db8:1:2::/64',
        '::1',
      ]);

      const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

      expect(clientIpOf('spoofed, 203.0.113.1 , 10.255.255.255, ::1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, 172.31.255.255, fd12::1, 192.168.1.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, 198.51.100.1')).toStrictEqual(ip('198.51.100.1'));
      expect(clientIpOf('203.0.113.1, 11.0.0.0')).toStrictEqual(ip('11.0.0.0'));
      expect(clientIpOf('203.0.113.1, 9.255.255.255')).toStrictEqual(ip('9.255.255.255'));
      expect(clientIpOf('203.0.113.1, 172.32.0.0')).toStrictEqual(ip('172.32.0.0'));
      expect(clientIpOf('203.0.113.1, 192.168.1.2')).toStrictEqual(ip('192.168.1.2'));
      expect(clientIpOf('203.0.113.1, fe80::1')).toStrictEqual(ip('fe80::1'));
      expect(clientIpOf('203.0.113.1, fcff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toStrictEqual(
        ip('fcff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'),
      );
      expect(clientIpOf('203.0.113.1, 2001:db8:1:2:ffff:ffff:ffff:ffff')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, 2001:db8:1:3::')).toStrictEqual(ip('2001:db8:1:3::'));
      expect(clientIpOf('203.0.113.1, ::2')).toStrictEqual(ip('::2'));
      // an ipv4 does not match an ipv6 subnet with the same leading bytes
      expect(clientIpOf('203.0.113.1, 253.0.0.1')).toStrictEqual(ip('253.0.0.1'));
      expect(clientIpOf('203.0.113.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('10.0.0.1')).toStrictEqual(none);
      expect(clientIpOf('10.0.0.1, 10.0.0.2')).toStrictEqual(none);
    });

    test('with ipv4 mapped ipv6 addresses, matching ipv4 subnets and resolving as ipv4', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

      expect(clientIpOf('203.0.113.1, ::ffff:10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, ::FFFF:10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, ::ffff:a00:1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, ::ffff:11.0.0.1')).toStrictEqual(ip('11.0.0.1'));
      expect(clientIpOf('::ffff:203.0.113.1, 10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('::FFFF:203.0.113.1, 10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('::ffff:cb00:7101, 10.0.0.1')).toStrictEqual(ip('203.0.113.1'));
    });

    test('with non canonical ips, the canonical form', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

      expect(clientIpOf('2001:DB8:0000:0:0::0001')).toStrictEqual(ip('2001:db8::1'));
      expect(clientIpOf('2001:0db8:0000:0000:0000:0000:0000:0001, 10.0.0.1')).toStrictEqual(ip('2001:db8::1'));
      expect(clientIpOf('0:0::1')).toStrictEqual(ip('::1'));
    });

    test('with zone ids, not a valid ip and never trusted', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8', 'fd00::/8']);

      const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

      expect(clientIpOf('fe80::1%eth0')).toStrictEqual(none);
      expect(clientIpOf('fe80::1%eth0, 10.0.0.1')).toStrictEqual(none);
      expect(clientIpOf('203.0.113.1, fd00::1%eth0')).toStrictEqual(none);
      expect(clientIpOf('203.0.113.1, ::ffff:10.0.0.1%eth0')).toStrictEqual(none);
    });

    test('with non ip entries, never trusted and never a client ip', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1, unknown, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1:54321, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': '[2001:db8::1]:443, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': 'junk, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': 'unknown, 203.0.113.1, 10.0.0.1' }))).toStrictEqual(
        ip('203.0.113.1'),
      );
    });

    test('with non ip client entry, the other headers get ignored', () => {
      const request = createRequest({
        'x-forwarded-for': 'unknown, 10.0.0.1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'example.com',
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'])(request)).toStrictEqual(none);
    });

    test('with all headers, aligned entries', () => {
      const request = createRequest({
        'x-forwarded-for': 'spoofed, 203.0.113.1, 10.0.0.1',
        'x-forwarded-proto': 'spoofed, HTTPS, http',
        'x-forwarded-host': 'spoofed, Example.com, internal',
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'])(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: 'example.com',
      });
    });

    test('with all headers, not aligned entries, the last entry', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      expect(
        resolve(
          createRequest({
            'x-forwarded-for': 'spoofed, 203.0.113.1, 10.0.0.1',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'spoofed, example.com',
          }),
        ),
      ).toStrictEqual({ clientIp: '203.0.113.1', scheme: 'https', host: 'example.com' });

      expect(
        resolve(
          createRequest({
            'x-forwarded-for': '203.0.113.1',
            'x-forwarded-proto': 'http, https',
            'x-forwarded-host': 'spoofed, example.com',
          }),
        ),
      ).toStrictEqual({ clientIp: '203.0.113.1', scheme: 'https', host: 'example.com' });
    });

    test('with blank proto and host entries', () => {
      const request = createRequest({
        'x-forwarded-for': '203.0.113.1',
        'x-forwarded-proto': '',
        'x-forwarded-host': ' ',
      });

      expect(createHeadersOnlyResolver(['10.0.0.0/8'])(request)).toStrictEqual(ip('203.0.113.1'));
    });

    test('with invalid proto and host entries, nothing but the client ip', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      const cases: Array<[string, string]> = [
        ['javascript', 'example com'],
        ['ht\ttps', 'example.com/path'],
        ['https;', 'https://example.com'],
        ['http-', 'user@example.com'],
        ['data', 'exämple.com'],
        ['ws', 'example..com'],
        ['wss', '-example.com'],
        ['ht tps', '2001:db8::1'],
        ['https:', '[junk]'],
        ['http/1.1', 'example.com:123456'],
        ['https://', 'example.com:65536'],
        ['h ttp', '[203.0.113.1]'],
        ['HTTPS;', '[2001:db8::1::2]'],
        ['https.', 'example.com:0'],
        ['httpss', '[fe80::1%eth0]'],
        ['http:', 'x[2001:db8::1]'],
        ['https-', '[2001:db8::1]x'],
      ];

      for (const [proto, host] of cases) {
        expect(
          resolve(
            createRequest({ 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': proto, 'x-forwarded-host': host }),
          ),
        ).toStrictEqual(ip('203.0.113.1'));
      }
    });

    test('with valid host entries, the lowercased host', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8']);

      const cases: Array<[string, string]> = [
        ['example.com', 'example.com'],
        ['example.com:8443', 'example.com:8443'],
        ['localhost', 'localhost'],
        ['a.example.com', 'a.example.com'],
        ['www.example.com', 'www.example.com'],
        ['example.com.', 'example.com.'],
        ['xn--exmple-cua.com', 'xn--exmple-cua.com'],
        ['my-example.com', 'my-example.com'],
        ['203.0.113.1', '203.0.113.1'],
        ['203.0.113.1:8080', '203.0.113.1:8080'],
        ['[2001:db8::1]', '[2001:db8::1]'],
        ['[2001:db8::1]:8080', '[2001:db8::1]:8080'],
        ['[::ffff:203.0.113.1]', '[::ffff:203.0.113.1]'],
        ['example.com:65535', 'example.com:65535'],
        ['example.com:1', 'example.com:1'],
        ['EXAMPLE.COM', 'example.com'],
        ['Example.Com:8443', 'example.com:8443'],
        ['[2001:DB8::1]', '[2001:db8::1]'],
      ];

      for (const [host, expectedHost] of cases) {
        expect(
          resolve(
            createRequest({ 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'HTTP', 'x-forwarded-host': host }),
          ),
        ).toStrictEqual({ clientIp: '203.0.113.1', scheme: 'http', host: expectedHost });
      }
    });

    test('with trusted remoteAddress, the headers get used', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8', '::1']);

      const headers = { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' };

      for (const remoteAddress of ['10.0.0.1', '10.0.0.1:54321', '::ffff:10.0.0.1', '[::1]:54321']) {
        expect(resolve(createRequest(headers, { remoteAddress }))).toStrictEqual({
          clientIp: '203.0.113.1',
          scheme: 'https',
          host: undefined,
        });
      }
    });

    test('with untrusted remoteAddress, the headers get ignored', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8']);

      const headers = { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' };

      const cases: Array<[string, string | undefined]> = [
        ['198.51.100.1', '198.51.100.1'],
        ['198.51.100.1:54321', '198.51.100.1'],
        ['2001:DB8::1', '2001:db8::1'],
        ['[2001:db8::1]:54321', '2001:db8::1'],
        ['::FFFF:198.51.100.1', '198.51.100.1'],
        ['[::ffff:198.51.100.1]:54321', '198.51.100.1'],
        ['', undefined],
        ['not-an-ip', undefined],
        ['198.51.100.1:54321junk', undefined],
        ['x[::1]:54321', undefined],
        ['[::1]:54321junk', undefined],
        ['fe80::1%eth0', undefined],
        ['10.0.0.1:port', undefined],
        ['10.0.0.1:', undefined],
        ['[::1]', undefined],
        ['[::1]:', undefined],
        ['[::1:54321', undefined],
      ];

      for (const [remoteAddress, clientIp] of cases) {
        expect(resolve(createRequest(headers, { remoteAddress }))).toStrictEqual({ ...none, clientIp });
      }
    });

    test('with non string remoteAddress, nothing gets resolved', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8']);

      for (const remoteAddress of [1, true, null, ['10.0.0.1'], { address: '10.0.0.1' }]) {
        expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1' }, { remoteAddress }))).toStrictEqual(none);
      }
    });

    test('without remoteAddress, nothing gets resolved', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8']);

      const headers = { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' };

      expect(resolve(createRequest(headers))).toStrictEqual(none);
      expect(resolve(createRequest(headers, { remoteAddress: undefined }))).toStrictEqual(none);
    });

    test('without remoteAddress, not required, the headers get used', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8'], DEFAULT_FORWARDED_HEADERS, false);

      const headers = { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' };

      expect(resolve(createRequest(headers))).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: undefined,
      });
      expect(resolve(createRequest(headers, { remoteAddress: undefined }))).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: undefined,
      });
      // a given address still anchors the trust
      expect(resolve(createRequest(headers, { remoteAddress: '198.51.100.1' }))).toStrictEqual(ip('198.51.100.1'));
      expect(resolve(createRequest(headers, { remoteAddress: 'not-an-ip' }))).toStrictEqual(none);
    });

    test('with custom headers', () => {
      const resolve = createHeadersOnlyResolver(['10.0.0.0/8'], { for: 'x-real-ip', proto: 'x-scheme', host: null });

      expect(
        resolve(
          createRequest({
            'x-forwarded-for': 'spoofed',
            'x-real-ip': '203.0.113.1',
            'x-scheme': 'https',
            'x-forwarded-host': 'spoofed',
          }),
        ),
      ).toStrictEqual({ clientIp: '203.0.113.1', scheme: 'https', host: undefined });
    });
  });

  describe('createTrustedProxyMiddleware', () => {
    test('without resolved values, the existing attributes get reset', async () => {
      const request = createRequest({}, { clientIp: 'existing', scheme: 'existing', host: 'existing', other: 'kept' });
      const response = new Response();

      const [forwardedResolver, forwardedResolverMocks] = useFunctionMock<ForwardedResolver>([
        { parameters: [request], return: none },
      ]);

      const [handler, handlerMocks] = useFunctionMock<Handler<TrustedProxyAttributes>>([
        {
          callback: async (givenRequest): Promise<Response> => {
            expect(givenRequest).not.toBe(request);
            expect(givenRequest.url).toBe(request.url);
            expect(givenRequest.attributes).toStrictEqual({
              clientIp: undefined,
              scheme: undefined,
              host: undefined,
              other: 'kept',
            });

            return response;
          },
        },
      ]);

      expect(await createTrustedProxyMiddleware(forwardedResolver)(request, handler)).toBe(response);

      expect(forwardedResolverMocks).toHaveLength(0);
      expect(handlerMocks).toHaveLength(0);
    });

    test('with resolved values, the attributes get set (existing ones overwritten, others kept)', async () => {
      const request = createRequest({}, { clientIp: 'spoofed', scheme: 'spoofed', other: 'kept' });
      const response = new Response();

      const [forwardedResolver, forwardedResolverMocks] = useFunctionMock<ForwardedResolver>([
        { parameters: [request], return: { clientIp: '203.0.113.1', scheme: 'https', host: 'example.com' } },
      ]);

      const [handler, handlerMocks] = useFunctionMock<Handler<TrustedProxyAttributes>>([
        {
          callback: async (givenRequest): Promise<Response> => {
            expect(givenRequest).not.toBe(request);
            expect(givenRequest.url).toBe(request.url);
            expect(givenRequest.attributes).toStrictEqual({
              clientIp: '203.0.113.1',
              scheme: 'https',
              host: 'example.com',
              other: 'kept',
            });

            return response;
          },
        },
      ]);

      expect(await createTrustedProxyMiddleware(forwardedResolver)(request, handler)).toBe(response);

      expect(forwardedResolverMocks).toHaveLength(0);
      expect(handlerMocks).toHaveLength(0);
    });

    test('with partially resolved values, only those get set, the existing others get reset', async () => {
      const request = createRequest({}, { scheme: 'existing', other: 'kept' });
      const response = new Response();

      const [forwardedResolver, forwardedResolverMocks] = useFunctionMock<ForwardedResolver>([
        { parameters: [request], return: ip('203.0.113.1') },
      ]);

      const [handler, handlerMocks] = useFunctionMock<Handler<TrustedProxyAttributes>>([
        {
          callback: async (givenRequest): Promise<Response> => {
            expect(givenRequest.attributes).toStrictEqual({
              clientIp: '203.0.113.1',
              scheme: undefined,
              host: undefined,
              other: 'kept',
            });

            return response;
          },
        },
      ]);

      expect(await createTrustedProxyMiddleware(forwardedResolver)(request, handler)).toBe(response);

      expect(forwardedResolverMocks).toHaveLength(0);
      expect(handlerMocks).toHaveLength(0);
    });
  });
});
