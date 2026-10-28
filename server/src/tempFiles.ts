/** 生成文件关闭智能（规格 feature-language-server-core 范围 7）
 *  Unity 编译产物：Temp/compiled-*、Temp/generatedFrom* —— 不索引、不解析、不响应请求。
 */
const GENERATED = /[\\/]Temp[\\/](?:compiled-|generatedFrom|__Generated)/i;

export function isGeneratedFile(fsPath: string): boolean {
  return GENERATED.test(fsPath);
}

/** CG 源文件（`.cginc`）：只做 include 解析与索引，**不做语义/类型诊断、不做内部排版**
 *  （project.md 不在范围；规格 feature-type-diagnostics 范围 1、feature-formatting 范围 2）。
 *  注意语言 id 上 `.cginc` 与 `.hlsl/.hlslinc` 同为 `hlsl`（client/package.json），只能按扩展名区分。 */
export function isCgSource(fsPath: string): boolean {
  return /\.cginc$/i.test(fsPath);
}
