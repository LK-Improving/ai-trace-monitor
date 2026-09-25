# Trace//Ops 原型

这是 AI 全链路监控平台的第一版可交互原型，使用原生 HTML / CSS / JavaScript，无需安装依赖。

视觉方向采用暖白底色、墨蓝交互色、细分隔线和紧凑数据排版；页面优先呈现请求趋势、告警、服务状态与 Trace。

## 本地预览

在仓库根目录执行：

```powershell
python -m http.server 4173
```

然后打开：

```text
http://127.0.0.1:4173/prototype/index.html
```

## 已覆盖页面

- 总览：实时指标、流量趋势、服务健康度、最近 Trace 和告警
- Trace Explorer：条件筛选、Trace 列表、Trace 详情、Span 执行树、属性面板
- 告警中心：告警指标、告警时间线、级别和状态
- AI 链路：模型调用、Token / 成本、RAG 质量信号
- 项目设置：采集策略、脱敏开关、项目密钥和 Header 示例
- 接入文档：服务端 Span 接入代码示例

原型使用模拟数据，重点用于评审信息架构、交互路径和页面密度，不代表最终 API 或视觉规范。
