/**
 * Bing Webmaster API fixtures, built from the JSON samples on the IWebmasterApi method reference pages
 * (getrankandtrafficstats, getcrawlstats, getquerystats, getpagestats, getcrawlissues, getusersites): `{"d": …}`
 * wrapper with `__type` noise and WCF dates "/Date(ms-0700)/". Values are made up; shapes are the documented ones.
 */
export const KEY = '0123456789abcdef0123456789abcdef';

const D1 = '/Date(1316156400000-0700)/'; // 2011-09-16
const D2 = '/Date(1316242800000-0700)/'; // 2011-09-17
const W2 = '/Date(1316761200000-0700)/'; // 2011-09-23

export const FIXTURES = {
  GetUserSites: {
    d: [
      { __type: 'Site:#Microsoft.Bing.Webmaster.Api', AuthenticationCode: 'ABC123', DnsVerificationCode: 'ABC123', IsVerified: true, Url: 'https://www.example.com/' },
      { __type: 'Site:#Microsoft.Bing.Webmaster.Api', AuthenticationCode: 'ABC123', DnsVerificationCode: 'ABC123', IsVerified: false, Url: 'https://example.org/' },
    ],
  },
  GetRankAndTrafficStats: {
    d: [
      { __type: 'RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api', Clicks: 12, Date: D1, Impressions: 340 },
      { __type: 'RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api', Clicks: 9, Date: D2, Impressions: 300 },
    ],
  },
  GetCrawlStats: {
    d: [
      { __type: 'CrawlStats:#Microsoft.Bing.Webmaster.Api', AllOtherCodes: 0, BlockedByRobotsTxt: 1, Code2xx: 110, Code301: 4, Code302: 0, Code4xx: 3, Code5xx: 1, ContainsMalware: 0, CrawlErrors: 2, CrawledPages: 120, Date: D1, InIndex: 98, InLinks: 40 },
      { __type: 'CrawlStats:#Microsoft.Bing.Webmaster.Api', AllOtherCodes: 0, BlockedByRobotsTxt: 1, Code2xx: 100, Code301: 4, Code302: 0, Code4xx: 0, Code5xx: 0, ContainsMalware: 0, CrawlErrors: 0, CrawledPages: 104, Date: D2, InIndex: 99, InLinks: 41 },
    ],
  },
  GetQueryStats: {
    d: [
      { __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', AvgClickPosition: 3.1, AvgImpressionPosition: 4.2, Clicks: 5, Date: D1, Impressions: 80, Query: 'harbor dental' },
      { __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', AvgClickPosition: -1, AvgImpressionPosition: 11.5, Clicks: 0, Date: D1, Impressions: 40, Query: 'dentist near me' },
      { __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', AvgClickPosition: 2.5, AvgImpressionPosition: 3.9, Clicks: 6, Date: W2, Impressions: 90, Query: 'harbor dental' },
    ],
  },
  GetPageStats: {
    d: [
      { __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', AvgClickPosition: 2, AvgImpressionPosition: 5, Clicks: 7, Date: D1, Impressions: 120, Query: 'https://www.example.com/services' },
      { __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', AvgClickPosition: 1, AvgImpressionPosition: 2, Clicks: 3, Date: D1, Impressions: 30, Query: 'https://www.example.com/' },
    ],
  },
  GetCrawlIssues: {
    d: [
      { __type: 'UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api', HttpCode: 404, InLinks: 3, Issues: 4, Url: 'https://www.example.com/old' },
      { __type: 'UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api', HttpCode: 301, InLinks: 1, Issues: 1, Url: 'https://www.example.com/moved' },
    ],
  },
};

/** Minimal fetch Response stand-in. */
export function jsonRes(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/** fetch fake routing by Bing method name; `overrides[method]` = response or (url) => response. */
export function bingFetch(overrides = {}, seen = []) {
  return async (url) => {
    const method = new URL(url).pathname.split('/').pop();
    seen.push(method);
    const o = overrides[method];
    if (typeof o === 'function') return o(url);
    if (o) return o;
    return jsonRes(200, FIXTURES[method] || { d: [] });
  };
}
