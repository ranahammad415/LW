import { describe, it, expect } from 'vitest';
import { parseGoogleUrl, extractGoogleUrlsFromText, kindFromMime } from '../../src/lib/googleKnowledge/urlParser.js';
import { extractFromGoogleDoc } from '../../src/lib/googleKnowledge/linkExtractor.js';
import { FILE_KIND } from '../../src/lib/googleKnowledge/constants.js';

describe('urlParser', () => {
  it('parses Google Doc URLs', () => {
    const r = parseGoogleUrl('https://docs.google.com/document/d/abc123_XYZ/edit');
    expect(r?.fileId).toBe('abc123_XYZ');
    expect(r?.kind).toBe(FILE_KIND.DOCUMENT);
  });

  it('parses Google Sheet URLs', () => {
    const r = parseGoogleUrl('https://docs.google.com/spreadsheets/d/sheet99/edit#gid=0');
    expect(r?.fileId).toBe('sheet99');
    expect(r?.kind).toBe(FILE_KIND.SPREADSHEET);
  });

  it('parses Drive file URLs', () => {
    const r = parseGoogleUrl('https://drive.google.com/file/d/file55/view');
    expect(r?.fileId).toBe('file55');
  });

  it('extracts multiple URLs from text', () => {
    const text = 'See https://docs.google.com/document/d/doc1/edit and https://docs.google.com/spreadsheets/d/sheet1/edit';
    const links = extractGoogleUrlsFromText(text);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.fileId).sort()).toEqual(['doc1', 'sheet1']);
  });

  it('kindFromMime maps Google types', () => {
    expect(kindFromMime('application/vnd.google-apps.document')).toBe(FILE_KIND.DOCUMENT);
    expect(kindFromMime('application/vnd.google-apps.spreadsheet')).toBe(FILE_KIND.SPREADSHEET);
  });
});

describe('linkExtractor', () => {
  it('extracts hyperlinks from doc structure', () => {
    const doc = {
      body: {
        content: [
          {
            paragraph: {
              elements: [
                {
                  textRun: {
                    content: 'Open sheet\n',
                    textStyle: {
                      link: { url: 'https://docs.google.com/spreadsheets/d/linked1/edit' },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const { links, plainText } = extractFromGoogleDoc(doc);
    expect(links).toHaveLength(1);
    expect(links[0].fileId).toBe('linked1');
    expect(plainText).toContain('Open sheet');
  });
});
