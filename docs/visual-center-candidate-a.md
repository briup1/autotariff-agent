# 候选 A：同进程会话管理与轮询投影

## 使用方式

浏览器创建会话，选择文件与说明，发送消息。HTTP 服务登记消息并异步调用既有 runPi。浏览器按秒读取真实业务账本的投影。一次只能有一个活动运行。运行结束后的后续消息创建关联新运行，并把前次运行、脚本和检查报告作为只读上下文传递。

## 数据形状

```ts
type Conversation = {
  id: string;
  title: string;
  sourceId: string;
  createdAt: string;
  messages: Message[];
  runIds: string[];
};
type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  runId?: string;
  createdAt: string;
};
type SourceOption = {
  id: string;
  label: string;
  kind: "sample" | "upload";
  supported: boolean;
};
type RunView = {
  runId: string;
  origin: "live" | "history" | "offline";
  phase: string;
  decision: string;
  active: boolean;
  actions: ActionView[];
  attempts: AttemptView[];
  usage: Record<string, number>;
};
```

核心 API 是创建会话、发送消息、读取会话、查看运行、读取许可产物和运行离线验证。发送消息用 requestId 去重。每个会话只允许一个任务写者，重复点击不产生多次模型消费。前端不接受任意本机路径和模型设置。

## 模块边界

- src/web/server.ts 负责 localhost HTTP、来源验证、静态资源与请求限制。
- src/web/service.ts 负责对话持久化、单运行调度和 runPi 接入。
- src/web/projection.ts 读取账本、摘要校验后的许可产物并分页。
- web/index.html、web/app.js、web/styles.css 是无构建静态界面。
- src/index.ts 保持 CLI 兼容，只增加必要的可选观察或上下文接入点。
- src/closure/live-budget.ts 为显式新任务增加授权预算。旧任务仍使用原 id 与上限。

## 接入限制

既有 runPi 用 pi.sqlite 维持 Agent 会话，但 TERMINAL 会直接返回。候选 A 不重开终态。不改变旧契约。终态后续消息使用新 run，显示关联。活动运行期间禁止第二个执行请求，界面仍能查看真实结果。

新任务预算按实际模型请求预留，最大 1000 次。单运行有限预算保持。回执不确定不自动补发。原有 all-batches 账本不重置。

## 验证

先验证原项目 54 项测试与类型检查。新增 API 测试覆盖路径逃逸、跨来源、重复发送、终态后续、许可产物和预算隔离。真实浏览器发送消息，检查网络请求、实际模型回执、运行与对话绑定。受控修复通过同一后端执行与检查链产生真实两轮产物。历史展示必须有明确历史标识。

## 权衡

优点是最少新增进程协议，直接复用 TypeScript 类型和 runPi。缺点是 HTTP 与运行共享一个进程，重启会打断模型请求。重启不能盲目恢复收费动作，必须按既有 UNCERTAIN 规则收敛。前端轮询账本只能展示实际已登记的动作，不能伪造模型思考或 Token 流。

视觉主方向是以对话为主的工具工作台，左侧会话，中间对话，右侧运行证据。与全屏运营仪表盘比较，优先保证发消息和查看修复反馈的连续性。
