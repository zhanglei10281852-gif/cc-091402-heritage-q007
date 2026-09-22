import { createApp } from "./app.js";
import { buildRuntime } from "./runtime.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";

const { service, monitor, path } = buildRuntime();
monitor.start(); // 启动即补扫停机期间到期的时间窗；冻结/提醒状态随事件日志恢复

const server = createApp({ service, monitor });
server.listen(port, host, () => {
  console.log(`文物运输交接服务已启动，事件日志：${path}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    monitor.stop();
    server.close(() => process.exit(0));
  });
}
