import { describe, expect, test } from 'vitest';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/dist/function-mock';
import type { Handler } from '@chubbyts/chubbyts-undici-server/dist/server';
import { Response, ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';
import type { ForwardedResolver, TrustedProxyAttributes } from '../src/middleware';
import { createForwardedResolver, createTrustedProxyMiddleware } from '../src/middleware';

const none = { clientIp: undefined, scheme: undefined, host: undefined };
const ip = (clientIp: string) => ({ ...none, clientIp });

const createRequest = (headers: Record<string, string> = {}, attributes: Record<string, unknown> = {}) =>
  new ServerRequest<TrustedProxyAttributes, Record<string, unknown>>('https://api.example.com/resource', {
    headers,
    attributes,
  });

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

    test('with invalid header names', () => {
      expect(() => createForwardedResolver(['10.0.0.0/8'], { for: 'bad header name' })).toThrow(
        'headers.for must be a valid header name, bad header name given',
      );
      expect(() => createForwardedResolver(['10.0.0.0/8'], { for: 'x-real-ip', host: '' })).toThrow(
        'headers.host must be a valid header name,  given',
      );
    });

    test('with untrimmed trusted proxies', () => {
      expect(
        createForwardedResolver([' 10.0.0.0/8 ', '::1\n'])(
          createRequest({ 'x-forwarded-for': '203.0.113.1, ::1, 10.0.0.1' }),
        ),
      ).toStrictEqual(ip('203.0.113.1'));
    });

    test('without headers', () => {
      expect(createForwardedResolver(['10.0.0.0/8'])(createRequest())).toStrictEqual(none);
    });

    test('without for header, the other headers get ignored', () => {
      expect(
        createForwardedResolver(['10.0.0.0/8'])(
          createRequest({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com' }),
        ),
      ).toStrictEqual(none);
    });

    test('with empty or blank for entries', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8']);

      expect(resolve(createRequest({ 'x-forwarded-for': '' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1, ' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': ' , 10.0.0.1' }))).toStrictEqual(none);
    });

    test('with ips and cidrs, the first untrusted entry from the right', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8', '172.16.0.0/12', '192.168.1.1', 'fd00::/8', '::1']);

      const clientIpOf = (forwardedFor: string) => resolve(createRequest({ 'x-forwarded-for': forwardedFor }));

      expect(clientIpOf('spoofed, 203.0.113.1 , 10.255.255.255, ::1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, 172.31.255.255, fd12::1, 192.168.1.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('203.0.113.1, 198.51.100.1')).toStrictEqual(ip('198.51.100.1'));
      expect(clientIpOf('203.0.113.1, 11.0.0.0')).toStrictEqual(ip('11.0.0.0'));
      expect(clientIpOf('203.0.113.1, 172.32.0.0')).toStrictEqual(ip('172.32.0.0'));
      expect(clientIpOf('203.0.113.1, 192.168.1.2')).toStrictEqual(ip('192.168.1.2'));
      expect(clientIpOf('203.0.113.1, fe80::1')).toStrictEqual(ip('fe80::1'));
      expect(clientIpOf('203.0.113.1, ::2')).toStrictEqual(ip('::2'));
      expect(clientIpOf('203.0.113.1')).toStrictEqual(ip('203.0.113.1'));
      expect(clientIpOf('10.0.0.1, 10.0.0.2')).toStrictEqual(none);
    });

    test('with ipv4 mapped ipv6 addresses', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8']);

      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1, ::ffff:10.0.0.1' }))).toStrictEqual(
        ip('203.0.113.1'),
      );
      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1, ::ffff:11.0.0.1' }))).toStrictEqual(
        ip('::ffff:11.0.0.1'),
      );
    });

    test('with non ip entries, never trusted and never a client ip', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8']);

      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1, unknown, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1:54321, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': '[2001:db8::1]:443, 10.0.0.1' }))).toStrictEqual(none);
      expect(resolve(createRequest({ 'x-forwarded-for': 'unknown, 203.0.113.1, 10.0.0.1' }))).toStrictEqual(
        ip('203.0.113.1'),
      );
    });

    test('with all headers, aligned entries', () => {
      const request = createRequest({
        'x-forwarded-for': 'spoofed, 203.0.113.1, 10.0.0.1',
        'x-forwarded-proto': 'spoofed, HTTPS, http',
        'x-forwarded-host': 'spoofed, example.com, internal',
      });

      expect(createForwardedResolver(['10.0.0.0/8'])(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: 'example.com',
      });
    });

    test('with all headers, not aligned entries, the last entry', () => {
      const request = createRequest({
        'x-forwarded-for': 'spoofed, 203.0.113.1, 10.0.0.1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'spoofed, example.com',
      });

      expect(createForwardedResolver(['10.0.0.0/8'])(request)).toStrictEqual({
        clientIp: '203.0.113.1',
        scheme: 'https',
        host: 'example.com',
      });
    });

    test('with blank proto and host entries', () => {
      const request = createRequest({
        'x-forwarded-for': '203.0.113.1',
        'x-forwarded-proto': '',
        'x-forwarded-host': ' ',
      });

      expect(createForwardedResolver(['10.0.0.0/8'])(request)).toStrictEqual(ip('203.0.113.1'));
    });

    test('with trusted remoteAddress, the headers get used', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8']);

      expect(
        resolve(
          createRequest(
            { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' },
            { remoteAddress: '10.0.0.1' },
          ),
        ),
      ).toStrictEqual({ clientIp: '203.0.113.1', scheme: 'https', host: undefined });
    });

    test('with untrusted remoteAddress, the headers get ignored', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8']);

      expect(
        resolve(
          createRequest(
            { 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' },
            { remoteAddress: '198.51.100.1' },
          ),
        ),
      ).toStrictEqual(ip('198.51.100.1'));
      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1' }, { remoteAddress: '' }))).toStrictEqual(none);
      expect(
        resolve(createRequest({ 'x-forwarded-for': '203.0.113.1' }, { remoteAddress: 'not-an-ip' })),
      ).toStrictEqual(none);
    });

    test('with non string remoteAddress, the headers get used', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8']);

      expect(resolve(createRequest({ 'x-forwarded-for': '203.0.113.1' }, { remoteAddress: 1 }))).toStrictEqual(
        ip('203.0.113.1'),
      );
    });

    test('with custom headers', () => {
      const resolve = createForwardedResolver(['10.0.0.0/8'], { for: 'x-real-ip', proto: 'x-scheme' });

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
