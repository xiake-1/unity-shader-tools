/** T-021 索引扩展：按前缀查名 API + `#define`/函数声明邻近注释存储
 *
 * 验收（spec:feature-completion）：
 * - 前缀查询单测：大小写敏感、字典序、空结果、limit；
 * - 注释抓取三例：行注释、块注释、无注释 → doc 为空；
 * - 性能不回退由 `npm run bench` 单独验证。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SymbolIndex } from '../../server/out/symbolIndex.js';

let root: string;
let index: SymbolIndex;

const HL = [
  '// 单行注释：雾效密度宏', //                    0
  '#define MY_FOG 1', //                           1
  '// 第一行', //                                  2
  '// 第二行', //                                  3
  '#define MY_TWO 2', //                           4
  '/* 块注释文档', //                              5
  ' * 取世界坐标到裁剪空间', //                    6
  ' */', //                                        7
  'float4 ToClip(float3 p) { return float4(p, 1); }', // 8
  'float NoCommentFn(float x) { return x; }', //   9  ← 上一行是函数体收尾，无注释
  'float Alpha;', //                               10
  'float alpha2;', //                              11
  'float _Beta;', //                               12
  '',
].join('\n');

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-t021-'));
  const f = path.join(root, 'a.hlsl');
  fs.writeFileSync(f, HL, 'utf8');
  index = new SymbolIndex();
  index.indexFile(f, HL);
});

describe('T-021 前缀查询 API', () => {
  it('大小写敏感：`Al` 命中 Alpha 不命中 alpha2', () => {
    const r = index.queryByPrefix('Al');
    expect(r.map((s) => s.name)).toEqual(['Alpha']);
    expect(index.queryByPrefix('al').map((s) => s.name)).toEqual(['alpha2']);
  });

  it('结果按字典序返回', () => {
    fs.writeFileSync(path.join(root, 'b.hlsl'), 'float Gam;\nfloat Gab;\nfloat Gaa;\n', 'utf8');
    index.indexFile(path.join(root, 'b.hlsl'), fs.readFileSync(path.join(root, 'b.hlsl'), 'utf8'));
    expect(index.queryByPrefix('Ga').map((s) => s.name)).toEqual(['Gaa', 'Gab', 'Gam']);
  });

  it('空结果：前缀无匹配返回空数组', () => {
    expect(index.queryByPrefix('Zzz')).toEqual([]);
  });

  it('limit 生效且不超过 limit', () => {
    const all = index.queryByPrefix('');
    expect(all.length).toBeGreaterThan(3);
    expect(index.queryByPrefix('', 3)).toHaveLength(3);
  });

  it('removeFile 后前缀查询不再返回该文件的符号', () => {
    index.removeFile(path.join(root, 'b.hlsl'));
    expect(index.queryByPrefix('Ga')).toEqual([]);
  });
});

describe('T-021 邻近注释抓取（文档存储）', () => {
  it('例 1：`//` 单行注释 → macro doc', () => {
    expect(index.getByName('MY_FOG')?.doc).toBe('单行注释：雾效密度宏');
  });

  it('连续多行 `//` 全部收入且保持顺序', () => {
    expect(index.getByName('MY_TWO')?.doc).toBe('第一行\n第二行');
  });

  it('例 2：`/* */` 块注释 → 函数 doc（去掉注释符号与 `*` 对齐符）', () => {
    expect(index.getByName('ToClip')?.doc).toBe('块注释文档\n取世界坐标到裁剪空间');
  });

  it('例 3：无邻近注释 → doc 为 undefined', () => {
    expect(index.getByName('NoCommentFn')?.doc).toBeUndefined();
  });

  it('kind 正确：preproc_def → macro，function_definition → function', () => {
    expect(index.getByName('MY_FOG')?.kind).toBe('macro');
    expect(index.getByName('ToClip')?.kind).toBe('function');
  });
});
