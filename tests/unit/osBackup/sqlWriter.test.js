import { describe, it, expect } from 'vitest';
import { encodeValue, InsertBatcher, statementLimits, columnKind, rowTuple, normalizeViewDdl, stripDefiner, quoteId } from '../../../src/lib/osBackup/sqlWriter.js';

describe('osBackup sqlWriter', () => {
  it('NULL, quotes, backslash and newlines stay on one line', () => {
    expect(encodeValue(null)).toBe('NULL');
    expect(encodeValue(undefined)).toBe('NULL');
    const s = encodeValue("it's a \"q\" \\ path\nline2\r\0\x1a");
    expect(s).not.toMatch(/[\n\r\0\x1a]/);
    expect(s).toBe("'it\\'s a \\\"q\\\" \\\\ path\\nline2\\r\\0\\Z'");
  });

  it('emoji / utf8mb4 are kept as UTF-8 text', () => {
    expect(encodeValue('héllo 😀 中文')).toBe("'héllo 😀 中文'");
  });

  it('Buffer becomes X\'hex\' (BLOB / BINARY / BIT)', () => {
    expect(encodeValue(Buffer.from([0, 1, 254, 255]), 'bin')).toBe("X'0001feff'");
    expect(encodeValue(Buffer.alloc(0), 'bin')).toBe("X''");
  });

  it('a JSON string is byte-for-byte unchanged (key order kept)', () => {
    const raw = '{"z":1,"a":[1,2],"m":{"k":"v"}}';
    expect(encodeValue(raw, 'json')).toBe(`'${raw.replace(/"/g, '\\"')}'`);
  });

  it('DATETIME(3) strings are not shifted', () => {
    expect(encodeValue('2026-03-29 01:30:00.123', 'str')).toBe("'2026-03-29 01:30:00.123'");
    expect(encodeValue(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)))).toBe("'2026-01-02 03:04:05.006'");
  });

  it('BIGINT / DECIMAL strings stay unquoted and exact; non-numeric text in a num column is quoted', () => {
    expect(encodeValue('18446744073709551615', 'num')).toBe('18446744073709551615');
    expect(encodeValue('-12345678901234567890.123456789', 'num')).toBe('-12345678901234567890.123456789');
    expect(encodeValue('1e+21', 'num')).toBe('1e+21');
    expect(encodeValue('1; DROP TABLE x', 'num')).toBe("'1; DROP TABLE x'");
    expect(encodeValue(0.1 + 0.2)).toBe(String(0.1 + 0.2));
    expect(encodeValue(12n)).toBe('12');
    expect(encodeValue(true)).toBe('1');
    expect(() => encodeValue(NaN)).toThrow();
  });

  it('column kinds', () => {
    expect(columnKind('bigint')).toBe('num');
    expect(columnKind('longblob')).toBe('bin');
    expect(columnKind('bit')).toBe('bin');
    expect(columnKind('json')).toBe('json');
    expect(columnKind('datetime')).toBe('str');
    expect(columnKind('longtext')).toBe('str');
  });

  it('respects the statement cap and puts an oversized row in its own statement', () => {
    const b = new InsertBatcher('t', ['a'], { cap: 100, hardMax: 10_000 });
    const outs = [];
    for (let i = 0; i < 10; i += 1) {
      const r = b.add(rowTuple({ a: 'x'.repeat(20) }, ['a'], ['str']));
      if (r) outs.push(r);
    }
    const big = b.add(`('${'y'.repeat(500)}')`);
    if (big) outs.push(big);
    outs.push(b.flush());
    for (const o of outs.slice(0, -1)) expect(Buffer.byteLength(o.sql)).toBeLessThanOrEqual(100);
    expect(outs[outs.length - 1].n).toBe(1);
    expect(outs[outs.length - 1].sql).toContain('y'.repeat(500));
    expect(outs.reduce((a, o) => a + o.n, 0)).toBe(11);
    expect(outs[0].sql.startsWith('INSERT INTO `t` (`a`) VALUES (')).toBe(true);
  });

  it('a row larger than max_allowed_packet fails with the table name', () => {
    const b = new InsertBatcher('wppage', ['html'], { cap: 100, hardMax: 1000 });
    expect(() => b.add(`('${'z'.repeat(2000)}')`, 'id-1')).toThrow(/wppage.*id-1/);
  });

  it('statement limits: min(4 MiB, packet / 4)', () => {
    expect(statementLimits(64 * 1024 * 1024)).toEqual({ cap: 4 * 1024 * 1024, hardMax: 64 * 1024 * 1024 - 1024 });
    expect(statementLimits(4 * 1024 * 1024).cap).toBe(1024 * 1024);
  });

  it('definer removed, views forced to SQL SECURITY INVOKER, identifiers quoted', () => {
    expect(normalizeViewDdl('CREATE ALGORITHM=UNDEFINED DEFINER=`u252`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1')).toBe(
      'CREATE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v` AS select 1'
    );
    expect(normalizeViewDdl('CREATE DEFINER=`a`@`%` VIEW `v` AS select 1')).toBe('CREATE SQL SECURITY INVOKER VIEW `v` AS select 1');
    expect(stripDefiner('CREATE DEFINER=`x`@`localhost` TRIGGER `t` BEFORE INSERT ON `a` FOR EACH ROW SET NEW.b = 1')).toBe(
      'CREATE TRIGGER `t` BEFORE INSERT ON `a` FOR EACH ROW SET NEW.b = 1'
    );
    expect(quoteId('we`ird')).toBe('`we``ird`');
  });
});
