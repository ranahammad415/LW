/**
 * Bing Webmaster client: WCF date parsing (doc sample vectors), {"d": …} unwrap, the error kinds (auth / throttle /
 * site / server) from the documented 400 {ErrorCode, Message} body and HTTP 429, one retry on 5xx and none on 400,
 * the per-instance slot clock (≥ 300 ms, BING_MAX_RPS), and the key never appearing in an error.
 * No real Bing call: fetch is a fake built from the documented response shapes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  bingDate,
  bingCall,
  classifyBingError,
  parseBingErrorBody,
  buildBingUrl,
  decodeIssueFlags,
  urlHash,
  bingSpacingMs,
  resetBingThrottle,
  getTrafficStats,
  getCrawlStats,
  getQueryStats,
  getPageStats,
  getCrawlIssues,
  getUserSites,
  BingApiError,
} from '../../../src/lib/bing/client.js';
import { FIXTURES, jsonRes, KEY } from './fixtures.js';

const CRED = { mode: 'api_key', apiKey: KEY };

function clock() {
  const c = { t: 1_000_000, waits: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.waits.push(ms);
    c.t += ms;
  };
  return c;
}

beforeEach(() => resetBingThrottle());

describe('bingDate', () => {
  it('parses the documented WCF sample with its Pacific offset', () => {
    expect(bingDate('/Date(1316156400000-0700)/')).toBe('2011-09-16');
  });
  it('handles a positive offset, no offset, ISO strings and junk', () => {
    // 2026-10-01T22:30Z + 05:30 → 2026-10-02 wall date
    expect(bingDate(`/Date(${Date.parse('2026-10-01T22:30:00Z')}+0530)/`)).toBe('2026-10-02');
    expect(bingDate(`/Date(${Date.parse('2026-10-01T00:00:00Z')})/`)).toBe('2026-10-01');
    expect(bingDate('2026-03-04T00:00:00')).toBe('2026-03-04');
    expect(bingDate(null)).toBeNull();
    expect(bingDate('/Date(abc)/')).toBeNull();
    expect(bingDate('yesterday')).toBeNull();
  });
});

describe('errors', () => {
  it('classifies by message substring and status', () => {
    expect(classifyBingError({ httpStatus: 400, message: 'InvalidApiKey' })).toBe('auth');
    expect(classifyBingError({ httpStatus: 400, message: 'UserNotFound' })).toBe('auth');
    expect(classifyBingError({ httpStatus: 400, message: 'ThrottleUser' })).toBe('throttle');
    expect(classifyBingError({ httpStatus: 429, message: '' })).toBe('throttle');
    expect(classifyBingError({ httpStatus: 400, message: 'SiteNotVerified' })).toBe('site');
    expect(classifyBingError({ httpStatus: 400, message: 'InvalidParameter' })).toBe('site');
    expect(classifyBingError({ httpStatus: 503, message: 'x' })).toBe('server');
    expect(classifyBingError({ httpStatus: 400, message: 'Weird' })).toBe('other');
  });
  it('parses the documented body and the WCF fault shape', () => {
    expect(parseBingErrorBody('{"ErrorCode":3,"Message":"InvalidApiKey"}')).toEqual({ errorCode: 3, message: 'InvalidApiKey' });
    expect(parseBingErrorBody('{"d":{"ErrorCode":14,"Message":"NotAuthorized"}}')).toEqual({ errorCode: 14, message: 'NotAuthorized' });
    expect(parseBingErrorBody('not json')).toEqual({ errorCode: null, message: null });
  });
});

describe('bingCall', () => {
  it('builds the API-key URL and unwraps {"d": …}', async () => {
    const c = clock();
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return jsonRes(200, FIXTURES.GetRankAndTrafficStats);
    };
    const rows = await getTrafficStats('https://www.example.com/', { credential: CRED, fetchImpl, sleep: c.sleep, now: c.now });
    expect(seen[0]).toMatch(/^https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/GetRankAndTrafficStats\?/);
    expect(new URL(seen[0]).searchParams.get('siteUrl')).toBe('https://www.example.com/');
    expect(new URL(seen[0]).searchParams.get('apikey')).toBe(KEY);
    expect(rows[0]).toEqual({ date: '2011-09-16', clicks: 12, impressions: 340 });
  });

  it('400 InvalidApiKey → auth, no retry, and the key is not in the error', async () => {
    const c = clock();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonRes(400, { ErrorCode: 3, Message: 'InvalidApiKey' });
    };
    const err = await bingCall('GetUserSites', { credential: CRED, fetchImpl, sleep: c.sleep, now: c.now }).catch((e) => e);
    expect(err).toBeInstanceOf(BingApiError);
    expect(err.kind).toBe('auth');
    expect(err.errorCode).toBe(3);
    expect(err.code).toBe('BING_InvalidApiKey');
    expect(calls).toBe(1);
    expect(`${err.message} ${err.stack} ${JSON.stringify(err)}`).not.toContain(KEY);
  });

  it('throttle (message or HTTP 429) is not retried', async () => {
    for (const res of [jsonRes(400, { ErrorCode: 0, Message: 'ThrottleUser' }), jsonRes(429, {})]) {
      const c = clock();
      let calls = 0;
      const err = await bingCall('GetUserSites', {
        credential: CRED,
        fetchImpl: async () => {
          calls += 1;
          return res;
        },
        sleep: c.sleep,
        now: c.now,
      }).catch((e) => e);
      expect(err.kind).toBe('throttle');
      expect(calls).toBe(1);
    }
  });

  it('retries once after 2 s on a 5xx / network error, then succeeds or gives up', async () => {
    const c = clock();
    let calls = 0;
    const stats = { calls: 0 };
    const ok = await bingCall('GetUserSites', {
      credential: CRED,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? jsonRes(503, {}) : jsonRes(200, FIXTURES.GetUserSites);
      },
      sleep: c.sleep,
      now: c.now,
      stats,
    });
    expect(calls).toBe(2);
    expect(stats.calls).toBe(2);
    expect(c.waits).toContain(2000);
    expect(ok).toHaveLength(2);
    resetBingThrottle();
    const c2 = clock();
    let n = 0;
    const err = await bingCall('GetUserSites', {
      credential: CRED,
      fetchImpl: async () => {
        n += 1;
        throw new TypeError(`fetch failed for ${buildBingUrl('GetUserSites', {}, CRED)}`);
      },
      sleep: c2.sleep,
      now: c2.now,
    }).catch((e) => e);
    expect(n).toBe(2);
    expect(err.kind).toBe('server');
    expect(err.message).not.toContain(KEY);
  });

  it('spaces calls ≥ 300 ms (BING_MAX_RPS=2 → 500 ms) per instance', async () => {
    const c = clock();
    const fetchImpl = async () => jsonRes(200, { d: [] });
    const env = { BING_MAX_RPS: '2' };
    for (let i = 0; i < 3; i += 1) await bingCall('GetUserSites', { credential: CRED, fetchImpl, sleep: c.sleep, now: c.now, env });
    expect(c.waits).toEqual([500, 500]);
    expect(bingSpacingMs({ BING_MAX_RPS: '10' })).toBe(300);
    expect(bingSpacingMs({})).toBe(500);
  });

  it('refuses to call without an API-key credential', async () => {
    const err = await bingCall('GetUserSites', { credential: null }).catch((e) => e);
    expect(err.code).toBe('BING_NOT_CONNECTED');
  });
});

describe('typed methods map the documented shapes', () => {
  const run = async (fn, method) => {
    const c = clock();
    return fn('https://www.example.com/', { credential: CRED, fetchImpl: async () => jsonRes(200, FIXTURES[method]), sleep: c.sleep, now: c.now });
  };
  it('GetUserSites drops verification codes', async () => {
    const c = clock();
    const sites = await getUserSites({ credential: CRED, fetchImpl: async () => jsonRes(200, FIXTURES.GetUserSites), sleep: c.sleep, now: c.now });
    expect(sites).toEqual([
      { siteUrl: 'https://www.example.com/', verified: true },
      { siteUrl: 'https://example.org/', verified: false },
    ]);
    expect(JSON.stringify(sites)).not.toMatch(/AuthenticationCode|DnsVerificationCode|ABC123/);
  });
  it('crawl stats, weekly queries/pages (−1 positions → null) and crawl issues', async () => {
    const crawl = await run(getCrawlStats, 'GetCrawlStats');
    expect(crawl[0]).toMatchObject({ date: '2011-09-16', crawledPages: 120, inIndex: 98, code4xx: 3, code5xx: 1, crawlErrors: 2 });
    const q = await run(getQueryStats, 'GetQueryStats');
    expect(q[0]).toMatchObject({ weekStart: '2011-09-16', query: 'harbor dental', clicks: 5, impressions: 80, avgImpressionPosition: 4.2 });
    expect(q[1].avgClickPosition).toBeNull();
    const p = await run(getPageStats, 'GetPageStats');
    expect(p[0]).toMatchObject({ url: 'https://www.example.com/services', clicks: 7 });
    const issues = await run(getCrawlIssues, 'GetCrawlIssues');
    expect(issues[0]).toEqual({ url: 'https://www.example.com/old', httpCode: 404, issuesRaw: 4, inLinks: 3 });
  });
  it('decodes issue flags best effort and hashes URLs without the fragment', () => {
    expect(decodeIssueFlags(4).map((l) => l.key)).toEqual(['code4xx']);
    expect(decodeIssueFlags(1 | 16).map((l) => l.key)).toEqual(['code301', 'blockedByRobotsTxt']);
    expect(decodeIssueFlags(1 << 12).map((l) => l.key)).toEqual(['other']);
    expect(urlHash(' https://x.com/a#top ')).toBe(urlHash('https://x.com/a'));
    expect(urlHash('https://x.com/a')).toMatch(/^[0-9a-f]{64}$/);
  });
});
