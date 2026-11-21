# 本地端口分配

| 端口 | 服务 | 项目路径 | 状态 |
| --- | --- | --- | --- |
| 3000 | AutoTariff Studio | /Users/ziyun/workdir/remote_project/autotariff-agent | 已分配 |

启动前 lsof 未发现该端口监听，curl 未收到响应。Docker API 当前不可用；本项目使用本地 Node 服务，实际 bind 若被占用应退出，不抢占现有服务。
