import { timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getHttpRuntime } from './runtime.js';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const runtime = await getHttpRuntime();
  const provided = Buffer.from(event.headers['x-origin-verify'] ?? '');
  const expected = Buffer.from(runtime.originSecret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return { statusCode: 403, body: '{"error":"Forbidden","code":"FORBIDDEN"}' };
  if (event.body && event.body.length > 32_768) return { statusCode: 413, body: '{"error":"Request too large","code":"INVALID_REQUEST"}' };
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) if (value) headers.set(key, value);
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));
  headers.delete('x-origin-verify');
  // CloudFront overwrites this header with viewer.ip; the origin secret above
  // prevents direct API callers from supplying their own trusted address.
  headers.set('x-btc-client-ip', event.headers['x-btc-client-ip'] ?? event.requestContext.http.sourceIp);
  const method = event.requestContext.http.method;
  const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : undefined;
  const request = new Request(`${runtime.origin}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`, {
    method, headers, ...(method !== 'GET' && method !== 'HEAD' && body ? { body } : {}),
  });
  const response = await runtime.handle(request);
  const outputHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => { if (key !== 'set-cookie') outputHeaders[key] = value; });
  return { statusCode: response.status, headers: outputHeaders, cookies: response.headers.getSetCookie(), body: await response.text() };
}
