/** 生成文件关闭智能（规格 feature-language-server-core 范围 7）
 *  Unity 编译产物：Temp/compiled-*、Temp/generatedFrom* —— 不索引、不解析、不响应请求。
 */
const GENERATED = /[\\/]Temp[\\/](?:compiled-|generatedFrom|__Generated)/i;

export function isGeneratedFile(fsPath: string): boolean {
  return GENERATED.test(fsPath);
}
