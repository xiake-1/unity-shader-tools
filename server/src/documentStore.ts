/** 文档同步与增量解析管线（规格范围 1/2/3、T-009）
 *
 * LSP didChange 支持全量与增量两种 contentChanges；这里统一换算成 tree-sitter 的
 * edit 描述，配合旧树做增量重解析（规格约束：单次编辑「解析 + 符号表更新」< 100ms）。
 */
import type { Tree } from './parser';
import { parseShaderLab, parseHlslFile, type Edit } from './parser';
import { isGeneratedFile } from './tempFiles';
import * as path from 'path';

export interface ContentChange {
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  text: string;
}

export interface DocState {
  text: string;
  tree: Tree | null;
  /** 生成文件：不解析、不索引 */
  generated: boolean;
}

const HLSL_EXT = /\.(hlsl|hlslinc|cginc|compute|raytrace)$/i;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetAt(starts: number[], line: number, character: number): number {
  const l = Math.min(Math.max(line, 0), starts.length - 1);
  return starts[l] + character;
}

export class DocumentStore {
  private docs = new Map<string, DocState>();

  open(file: string, text: string): DocState {
    const generated = isGeneratedFile(file);
    const state: DocState = { text, tree: null, generated };
    if (!generated) state.tree = this.parse(file, text, null);
    this.docs.set(file, state);
    return state;
  }

  private parse(file: string, text: string, oldTree: Tree | null, edits?: Edit[]): Tree | null {
    // .hlsl 等独立文件没有 ShaderLab 外壳，直接按 HLSL 解析（规格异常与边界表）；
    // M2 起这条路径必须走对，否则打开的 .hlsl 文档拿不到 HLSL 树，跳转与成员访问全失效。
    if (HLSL_EXT.test(path.extname(file))) return parseHlslFile(text, oldTree ?? undefined, edits);
    return parseShaderLab(text, oldTree ?? undefined, edits);
  }

  /** 应用一次 didChange；返回新的解析树（生成文件返回 null） */
  change(file: string, changes: ContentChange[]): DocState | null {
    const state = this.docs.get(file);
    if (!state || state.generated) return state ?? null;

    let text = state.text;
    const edits: Edit[] = [];
    for (const ch of changes) {
      const starts = lineStarts(text);
      if (!ch.range) {
        // 全量替换：整篇视为一次编辑
        edits.push({
          startIndex: 0,
          oldEndIndex: text.length,
          newEndIndex: ch.text.length,
          startPosition: { row: 0, column: 0 },
          oldEndPosition: {
            row: starts.length - 1,
            column: text.length - starts[starts.length - 1],
          },
          newEndPosition: {
            row: lineStarts(ch.text).length - 1,
            column: ch.text.length - lineStarts(ch.text)[lineStarts(ch.text).length - 1],
          },
        });
        text = ch.text;
        continue;
      }
      const startIndex = offsetAt(starts, ch.range.start.line, ch.range.start.character);
      const oldEndIndex = offsetAt(starts, ch.range.end.line, ch.range.end.character);
      const newText = ch.text;
      const newLines = lineStarts(newText);
      edits.push({
        startIndex,
        oldEndIndex,
        newEndIndex: startIndex + newText.length,
        startPosition: { row: ch.range.start.line, column: ch.range.start.character },
        oldEndPosition: { row: ch.range.end.line, column: ch.range.end.character },
        newEndPosition: {
          row: ch.range.start.line + newLines.length - 1,
          column:
            newLines.length === 1
              ? ch.range.start.character + newText.length
              : newText.length - newLines[newLines.length - 1],
        },
      });
      text = text.slice(0, startIndex) + newText + text.slice(oldEndIndex);
    }

    state.tree = this.parse(file, text, state.tree, edits);
    state.text = text;
    return state;
  }

  close(file: string): void {
    this.docs.delete(file);
  }

  get(file: string): DocState | undefined {
    return this.docs.get(file);
  }

  isGenerated(file: string): boolean {
    return isGeneratedFile(file);
  }
}

/** 索引侧的解析入口：按扩展名选择 grammar（.shader 走 ShaderLab，.hlsl 走 HLSL） */
export function parseForIndex(file: string, text: string): Tree | null {
  if (isGeneratedFile(file)) return null;
  return HLSL_EXT.test(path.extname(file)) ? parseHlslFile(text) : parseShaderLab(text);
}
