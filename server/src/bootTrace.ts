/** 启动痕迹：必须在其它 import 之前执行，用来区分
 *  「进程根本没被 spawn」与「进程起来了但后续 require 失败」。
 */
const log = process.env.UNITYSHADER_SERVER_LOG;
if (log) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('fs').appendFileSync(log, `${Date.now()} boot pid=${process.pid}\n`, 'utf8');
  } catch {
    /* 日志不可写不影响服务 */
  }
}
