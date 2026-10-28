import test from 'node:test';
import assert from 'node:assert/strict';
import { lastReportLine } from '../src/report.js';
import { redact } from '../src/redact.js';

test('取最后一行 🔊，去掉表情', () => {
  assert.equal(lastReportLine('done\n🔊 First\nmore\n🔊 Tests pass; restart the server.\n'), 'Tests pass; restart the server.');
});
test('没有 🔊 就不念', () => {
  assert.equal(lastReportLine('just text\nno marker'), null);
  assert.equal(lastReportLine(''), null);
  assert.equal(lastReportLine(undefined), null);
});
test('代码块里的 🔊 不算；带变体选择符和引用符的算', () => {
  assert.equal(lastReportLine('```\n🔊 example\n```'), null);
  assert.equal(lastReportLine('> 🔊\uFE0F 好了'), '好了');
  assert.equal(lastReportLine('**🔊 搞定了**'), '搞定了');
});
test('🔊 挤在最后一行中间也认；不在最后一行的不认', () => {
  assert.equal(lastReportLine('Done. 🔊 The build finished and all tests pass.'), 'The build finished and all tests pass.');
  assert.equal(lastReportLine('done. 🔊️ 好了'), '好了');
  assert.equal(lastReportLine('I added a 🔊 icon to the button.\nAll set.'), null);
  assert.equal(lastReportLine('Done. 🔊'), null);
});
test('最后一行空就退回上一条非空', () => {
  assert.equal(lastReportLine('🔊 A\n🔊'), 'A');
});
test('报告句里的密钥被抹掉', () => {
  const cases = [
    ['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'sk-ant'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_'],
    ['AKIAIOSFODNN7EXAMPLE leaked', 'AKIA'],
    ['password: hunter2 ok', 'hunter2'],
    ['the password is hunter2.', 'hunter2'],
    ['API_KEY=abc123def456 set', 'abc123def456'],
    ['密码是 Zx9!kLm 请保管', 'Zx9'],
    ['Authorization: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123_- end', 'eyJhbGci'],
    ['commit 0123456789abcdef0123456789abcdef01234567', '0123456789abcdef'],
    ['url https://bob:s3cret@example.com/x', 's3cret'],
    ['blob aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k', 'aB3dE5gH7j'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----', 'MIIEabc'],
  ];
  for (const [input, leak] of cases) {
    const r = lastReportLine('🔊 ' + input.split('\n').join(' '));
    assert.ok(r && !r.includes(leak), `leaked ${leak}: ${r}`);
    assert.ok(!redact(input).includes(leak), `redact leaked ${leak}`);
  }
});
test('正常句子原样保留', () => {
  const s = 'Fixed the login bug in 3 files; you need to run the migration.';
  assert.equal(lastReportLine('🔊 ' + s), s);
  assert.equal(redact('see src/very-long-kebab-case-identifier-name-here'), 'see src/very-long-kebab-case-identifier-name-here');
});
test('超长截到 500', () => {
  assert.equal(lastReportLine('🔊 ' + 'a '.repeat(600)).length <= 500, true);
});
