/** 重命名（规格 feature-rename，T-030 / T-031）：引用收集 + 批量 WorkspaceEdit。
 *
 * 与 references 共用 `resolveSymbolAt`（同一 token→逻辑符号路径，设计原则 2）；
 * 每处只替换名字 token 的 Range；内置/包内声明拒绝；只生成工程用户源的 edit；
 * Properties 属性改名联动 `sampler_<旧名>` 并发 Info 资产提示；
 * 新名校验（标识符 / 关键字冲突 / 同作用域占用）；存在性校验；不可解析处 `unresolved=N`。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ResponseError,
  type Range,
  type TextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver';
import { pathToFileURL } from 'url';
import type Parser from 'tree-sitter';
import { isGeneratedFile } from './tempFiles';
import type { SymbolIndex } from './symbolIndex';
import type { DocumentStore } from './documentStore';
import type { IncludeContext } from './includeResolver';
import { collectOccurrences, samplerOccurrences } from './occurrences';
import {
  collectMemberOccurrences,
  resolveSymbolAt,
  type ReferenceContext,
} from './references';

type SyntaxNode = Parser.SyntaxNode;

export interface RenameContext extends ReferenceContext {
  /** Properties 改名后的资产失效提示（server.ts 接 window/showMessage(Info)） */
  notifyInfo?: (msg: string) => void;
}

/** HLSL 关键字与内置类型名：新名不得占用（规格「新名字校验」） */
const RESERVED = new Set([
  'auto','bool','break','case','cbuffer','column_major','const','continue','default','discard',
  'do','else','extern','for','groupshared','if','in','inline','inout','intrinsic','namespace',
  'out','packed','precise','row_major','return','static','struct','switch','typedef','uniform',
  'uniform','void','while','true','false','sampler','sampler1D','sampler2D','sampler3D',
  'samplerCUBE','sampler_state','Texture1D','Texture2D','Texture3D','Buffer','StructuredBuffer',
  'RWBuffer','RWStructuredBuffer','AppendStructuredBuffer','ConsumeStructuredBuffer',
  'min16float','min10float','min16int','min12int','min16uint',
]);
const BASE_TYPES = ['float','half','double','int','uint','bool'];
function isBuiltinType(name: string): boolean {
  if (RESERVED.has(name)) return true;
  // floatN / floatNxM / halfN / intN / uintN / boolN 形态
  return new RegExp(`^(${BASE_TYPES.join('|')})([1-4](x[1-4])?)?$`).test(name);
}

const norm = (p: string): string => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const under = (file: string, dir: string | null): boolean =>
  !!dir && norm(file).startsWith(norm(dir) + path.sep);

function rangeOfNode(n: { startPosition: { row: number; column: number }; endPosition: { row: number; column: number } }): Range {
  return {
    start: { line: n.startPosition.row, character: n.startPosition.column },
    end: { line: n.endPosition.row, character: n.endPosition.column },
  };
}

/** 符号的声明是否全部位于包内/内置源（内置/包内声明拒绝改名，规格异常表） */
function allDeclsReadOnly(files: string[], ctx: RenameContext): boolean {
  if (!files.length) return false;
  return files.every(
    (f) => under(f, ctx.includeCtx.packageCacheDir) || under(f, ctx.includeCtx.cgIncludesDir)
  );
}

export function prepareRename(
  file: string,
  line: number,
  character: number,
  ctx: RenameContext
): { range: Range; placeholder: string } | null | ResponseError {
  if (isGeneratedFile(file)) return null;
  const sym = resolveSymbolAt(file, line, character, ctx);
  if (!sym) return null;

  if (sym.kind === 'global') {
    const info = ctx.index.getByName(sym.name);
    if (!info) return null; // 不在符号索引里：不是我们的逻辑符号
    if (allDeclsReadOnly(info.locations.map((l) => l.file), ctx)) {
      return new ResponseError(0, `内置/包内符号不可改名：${sym.name}`);
    }
  } else if (sym.kind === 'member') {
    if (!sym.structName) return null; // 左侧类型不可浅推断：宁漏勿错
    const field = ctx.index.getByName(sym.name);
    const owned = (field?.locations ?? []).filter((l) => l.owner === sym.structName);
    const struct = ctx.index.getByName(sym.structName);
    const declFiles = (owned.length ? owned : struct?.locations ?? []).map((l) => l.file);
    if (declFiles.length && allDeclsReadOnly(declFiles, ctx)) {
      return new ResponseError(0, `内置/包内符号不可改名：${sym.structName}.${sym.name}`);
    }
  }
  // local：当前文件内符号，可改
  return { range: rangeOfNode(sym.node), placeholder: sym.name };
}

interface EditAccum {
  byFile: Map<string, TextEdit[]>;
  skippedReadOnly: number;
  skippedMissing: number;
}

function addEdit(
  acc: EditAccum,
  ctx: RenameContext,
  file: string,
  range: Range,
  newText: string
): void {
  if (isGeneratedFile(file)) return;
  if (under(file, ctx.includeCtx.packageCacheDir) || under(file, ctx.includeCtx.cgIncludesDir)) {
    acc.skippedReadOnly++;
    return;
  }
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a file');
  } catch {
    acc.skippedMissing++;
    ctx.log(`rename: 跳过不存在的文件 ${file}`);
    return;
  }
  let arr = acc.byFile.get(file);
  if (!arr) {
    arr = [];
    acc.byFile.set(file, arr);
  }
  if (!arr.some((e) => e.range.start.line === range.start.line && e.range.start.character === range.start.character)) {
    arr.push({ range, newText });
  }
}

export function rename(
  file: string,
  line: number,
  character: number,
  newName: string,
  ctx: RenameContext
): WorkspaceEdit | ResponseError {
  if (isGeneratedFile(file)) return new ResponseError(0, '生成文件不可改名');

  // 1) 新名字校验（规格第 9 条：违反 → 错误消息，不产生半成品 edit）
  if (!newName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
    return new ResponseError(0, `新名字不是合法的 HLSL 标识符：${JSON.stringify(newName)}`);
  }
  if (isBuiltinType(newName)) {
    return new ResponseError(0, `新名字与 HLSL 关键字或内置类型冲突：${newName}`);
  }

  const sym = resolveSymbolAt(file, line, character, ctx);
  if (!sym) return new ResponseError(0, '光标处不是可改名的符号');

  // 2) 同作用域占用
  if (sym.kind === 'member' && sym.structName) {
    if (ctx.index.fieldsOfStruct(sym.structName).some((f) => f.name === newName)) {
      return new ResponseError(0, `struct ${sym.structName} 已有字段 ${newName}`);
    }
  } else if (sym.kind === 'global') {
    const clash = ctx.index.getByName(newName);
    if (clash && clash.name !== sym.name) {
      return new ResponseError(0, `工程内已有同名符号 ${newName}`);
    }
  }

  const acc: EditAccum = { byFile: new Map(), skippedReadOnly: 0, skippedMissing: 0 };
  let unresolved = 0;

  if (sym.kind === 'global') {
    const info = ctx.index.getByName(sym.name);
    if (!info) return new ResponseError(0, `符号 ${sym.name} 不在索引中`);
    if (allDeclsReadOnly(info.locations.map((l) => l.file), ctx)) {
      return new ResponseError(0, `内置/包内符号不可改名：${sym.name}`);
    }
    // 声明所在文件本身缺失 → 错误，不产生 edit（规格异常表）
    const declFiles = [...new Set(info.locations.map((l) => l.file))];
    if (declFiles.length && !declFiles.some((f) => fs.existsSync(f))) {
      return new ResponseError(0, `声明所在文件已缺失，取消改名：${sym.name}`);
    }

    const occ = collectOccurrences(sym.name, { index: ctx.index, store: ctx.store, log: ctx.log });
    unresolved = occ.unresolved;
    for (const o of occ.occurrences) {
      addEdit(acc, ctx, o.file, o.range, newName);
    }

    // Properties 联动：sampler_<旧名> → sampler_<新名>（约定名；自定义采样器名不联动）
    if (info.kind === 'property') {
      const so = samplerOccurrences(sym.name, { index: ctx.index, store: ctx.store, log: ctx.log });
      const newSampler = `sampler_${newName.replace(/^_+/, '')}`;
      for (const o of so.occurrences) {
        addEdit(acc, ctx, o.file, o.range, newSampler);
      }
      ctx.notifyInfo?.(
        `属性 ${sym.name} 已改名为 ${newName}：材质（.mat）与场景（.unity）里该属性的序列化值不会自动迁移，` +
          '请在 Unity 中重新检查受影响的材质与场景。'
      );
    }
  } else if (sym.kind === 'member') {
    if (!sym.structName) return new ResponseError(0, '无法解析该成员的所属 struct，取消改名（宁漏勿错）');
    const m = collectMemberOccurrences(sym.structName, sym.name, ctx);
    unresolved = m.unresolved;
    for (const o of m.occurrences) {
      if (o.resolvable) addEdit(acc, ctx, o.file, o.range, newName);
    }
  } else {
    // local：只改当前文件所在函数体（resolveSymbolAt 已限定 fnNode）
    const seen = new Set<string>();
    const walk = (n: SyntaxNode): void => {
      if (n.childCount === 0) {
        if ((n.type === 'identifier' || n.type === 'type_identifier') && n.text === sym.name) {
          const key = `${n.startPosition.row}:${n.startPosition.column}`;
          if (!seen.has(key)) {
            seen.add(key);
            addEdit(acc, ctx, file, rangeOfNode(n), newName);
          }
        }
        return;
      }
      for (const c of n.children) walk(c);
    };
    walk(sym.fnNode);
  }

  if (unresolved > 0) ctx.log(`rename: ${sym.name} unresolved=${unresolved}`);
  if (acc.skippedReadOnly) ctx.log(`rename: ${sym.name} 跳过包内/内置文件 ${acc.skippedReadOnly} 处`);

  const changes: { [uri: string]: TextEdit[] } = {};
  let totalEdits = 0;
  for (const [f, edits] of acc.byFile) {
    changes[pathToFileURL(f).toString()] = edits;
    totalEdits += edits.length;
  }
  if (totalEdits === 0) return new ResponseError(0, `没有找到可改名的 occurrence：${sym.name}`);
  ctx.log(
    `rename: ${sym.name} → ${newName} edits=${totalEdits} files=${acc.byFile.size} ` +
      `unresolved=${unresolved} missing=${acc.skippedMissing}`
  );
  return { changes };
}
