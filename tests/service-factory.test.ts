import { describe, expect, test } from 'vitest';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/dist/function-mock';
import { useObjectMock } from '@chubbyts/chubbyts-function-mock/dist/object-mock';
import type { Container } from '@chubbyts/chubbyts-dic-types/dist/container';
import type { ConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import { createContainerByConfigFactory } from '@chubbyts/chubbyts-dic-config/dist/dic-config';
import type { Handler, Middleware } from '@chubbyts/chubbyts-undici-server/dist/server';
import { Response, ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';
import type { ForwardedResolver, TrustedProxyAttributes } from '../src/middleware';
import type { TrustedProxyConfig } from '../src/service-factory';
import { forwardedResolverServiceFactory, trustedProxyMiddlewareServiceFactory } from '../src/service-factory';

// the create functions return opaque closures, so the wiring gets proven by exercising the created services against
// requests and mocked collaborators (forwarded resolver, handler)

const createRequest = (headers: Record<string, string> = {}, attributes: Record<string, unknown> = {}) =>
  new ServerRequest('https://api.example.com/resource', { headers, attributes });

describe('service-factory', () => {
  describe('forwardedResolverServiceFactory', () => {
    test('without name, with defaults', () => {
      const trustedProxyConfig: TrustedProxyConfig = { trustedProxies: ['10.0.0.0/8'] };

      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'get', parameters: ['config'], return: { chubbyts: { trustedProxy: trustedProxyConfig } } },
      ]);

      const service = forwardedResolverServiceFactory()(container);

      expect(
        service(
          createRequest(
            {
              'x-forwarded-for': '203.0.113.1, 10.0.0.1',
              'x-forwarded-proto': 'https',
              'x-forwarded-host': 'example.com',
            },
            { remoteAddress: '10.0.0.2' },
          ),
        ),
      ).toEqual({ clientIp: '203.0.113.1', scheme: 'https', host: 'example.com' });
      expect(service(createRequest({ 'x-forwarded-for': '203.0.113.1' }, { remoteAddress: '198.51.100.1' }))).toEqual({
        clientIp: '198.51.100.1',
      });

      expect(containerMocks).toHaveLength(0);
    });

    test('with name, with headers', () => {
      const [container, containerMocks] = useObjectMock<Container>([
        {
          name: 'get',
          parameters: ['config'],
          return: {
            chubbyts: {
              trustedProxy: {
                api: { trustedProxies: ['10.0.0.0/8'], headers: { for: 'x-real-ip' } },
                other: { trustedProxies: ['::1'] },
              },
            },
          },
        },
      ]);

      const service = forwardedResolverServiceFactory('api')(container);

      expect(
        service(
          createRequest({ 'x-forwarded-for': 'spoofed', 'x-real-ip': '203.0.113.1', 'x-forwarded-proto': 'https' }),
        ),
      ).toEqual({ clientIp: '203.0.113.1' });

      expect(containerMocks).toHaveLength(0);
    });

    test('with missing or invalid config', () => {
      const cases: Array<[string, unknown, string]> = [
        ['', {}, 'config.chubbyts.trustedProxy.trustedProxies must be an array of ips or cidrs, undefined given'],
        [
          '',
          { chubbyts: {} },
          'config.chubbyts.trustedProxy.trustedProxies must be an array of ips or cidrs, undefined given',
        ],
        [
          '',
          { chubbyts: { trustedProxy: { trustedProxies: '10.0.0.0/8' } } },
          'config.chubbyts.trustedProxy.trustedProxies must be an array of ips or cidrs, string given',
        ],
        [
          'api',
          { chubbyts: { trustedProxy: { other: { trustedProxies: ['::1'] } } } },
          'config.chubbyts.trustedProxy.api.trustedProxies must be an array of ips or cidrs, undefined given',
        ],
      ];

      for (const [name, config, message] of cases) {
        const [container, containerMocks] = useObjectMock<Container>([
          { name: 'get', parameters: ['config'], return: config },
        ]);

        expect(() => forwardedResolverServiceFactory(name)(container)).toThrow(new TypeError(message));

        expect(containerMocks).toHaveLength(0);
      }
    });
  });

  describe('trustedProxyMiddlewareServiceFactory', () => {
    test('without name, with shipped resolver', async () => {
      const trustedProxyConfig: TrustedProxyConfig = { trustedProxies: ['10.0.0.0/8'] };

      const request = createRequest({ 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' });
      const response = new Response();

      const [handler, handlerMocks] = useFunctionMock<Handler<TrustedProxyAttributes>>([
        {
          callback: async (givenRequest): Promise<Response> => {
            expect(givenRequest.attributes).toEqual({ clientIp: '203.0.113.1', scheme: 'https' });

            return response;
          },
        },
      ]);

      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'has', parameters: ['trustedProxyForwardedResolver'], return: false },
        { name: 'get', parameters: ['config'], return: { chubbyts: { trustedProxy: trustedProxyConfig } } },
      ]);

      const service = trustedProxyMiddlewareServiceFactory()(container);

      expect(await service(request, handler)).toBe(response);

      expect(handlerMocks).toHaveLength(0);
      expect(containerMocks).toHaveLength(0);
    });

    test('with name, with registered resolver', async () => {
      const request = createRequest();
      const response = new Response();

      const [forwardedResolver, forwardedResolverMocks] = useFunctionMock<ForwardedResolver>([
        { parameters: [request], return: { clientIp: '203.0.113.1', scheme: 'https', host: undefined } },
      ]);

      const [handler, handlerMocks] = useFunctionMock<Handler<TrustedProxyAttributes>>([
        {
          callback: async (givenRequest): Promise<Response> => {
            expect(givenRequest.attributes).toEqual({ clientIp: '203.0.113.1', scheme: 'https' });

            return response;
          },
        },
      ]);

      const [container, containerMocks] = useObjectMock<Container>([
        { name: 'has', parameters: ['trustedProxyForwardedResolverapi'], return: true },
        { name: 'get', parameters: ['trustedProxyForwardedResolverapi'], return: forwardedResolver },
      ]);

      const service = trustedProxyMiddlewareServiceFactory('api')(container);

      expect(await service(request, handler)).toBe(response);

      expect(forwardedResolverMocks).toHaveLength(0);
      expect(handlerMocks).toHaveLength(0);
      expect(containerMocks).toHaveLength(0);
    });

    test('with chubbyts-dic-config container', async () => {
      const container = createContainerByConfigFactory({
        chubbyts: {
          trustedProxy: { trustedProxies: ['10.0.0.0/8'] } satisfies TrustedProxyConfig,
        },
        dependencies: {
          factories: new Map<string, ConfigFactory>([
            ['trustedProxyMiddleware', trustedProxyMiddlewareServiceFactory()],
          ]),
        },
      })();

      const middleware = container.get<Middleware<TrustedProxyAttributes>>('trustedProxyMiddleware');

      const response = await middleware(
        createRequest({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' }),
        async (request) => new Response(JSON.stringify(request.attributes)),
      );

      expect(await response.json()).toEqual({ clientIp: '203.0.113.1' });
    });
  });
});
