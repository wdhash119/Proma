---
name: jev-use
version: 1.0.6
group: proma
description: 使用已配置的 Jev 协助多步骤桌面或网页任务，在候选操作之间选择下一步，并由 Cua 执行和验证。用户指定 Jev、需要候选决策流程或调整现有 Jev 自动化方案时使用；普通微信、表单或窗口操作直接使用 cua-driver-cli。
source: https://github.com/trycua/cua/tree/main/skills/jev-use
---

# 使用已有 Jev 决策方案

Jev 选择下一步，Cua 观察和执行。保持两者分工，不把模型、凭据或例程依赖塞进 Driver 或 Proma。

## 复用配置

读取一次配置目录（默认 `~/.proma`，开发模式 `~/.proma-dev`）下 `computer-use.md` 中的 Jev 目录、运行方式和验证状态，复用现有服务。不要每轮运行环境检查、安装依赖或 Mock 验证；真实调用失败时才诊断相关部分。没有配置时，告知用户尚未配置 Cua Driver 与可选 Jev，需要先在配置目录下的 `computer-use.md` 记录 `driver_path:` 与 Jev 目录、运行方式，或完成安装配置；无需 Jev 时直接完成普通 Cua 任务。

macOS 用已有 Bash 路径；Windows 使用原生 PowerShell、带引号的绝对路径与 `&`，需要时仅在当前进程设置 `CUA_DRIVER_BIN`。不假定前一次工具调用的环境变量仍在。

## 候选决策与执行

1. 先按 `cua-driver-cli` 观察准确的目标。微信、自绘界面或画布没有可用 AX/UIA 控件时读取截图，不循环请求空树。
2. 调用方根据最新观察构造少量完整候选：每项包含确定的工具与参数。保留重新观察和停止选项；权限与用户授权在进入候选表前检查。
3. 给 Jev 最小必要的目标、观察摘要、候选 ID 与描述。Jev 返回的 ID 必须来自原候选表，不能让它自行发明坐标、工具名、收件人或输入内容。
4. 校验协议、候选唯一性、置信度和观察有效期；未知 ID、过期图像或歧义结果均不执行。视觉区域方案仅在当前 Driver 支持对应协议和捕获绑定时使用，坐标需对应原始图像。
5. 执行选定动作后检查实际应用状态，再生成下一组候选。模型回答和动作成功回执都不证明任务完成。需要用户确认时，按 Cua Skill 展示当前截图并暂停，确认后重新观察。

真实服务可能计费，只使用已授权的配置。密钥通过现有安全配置或安全输入提供，不放进聊天、候选、日志或截图。Mock 结果与真实服务结果分别报告。

接口不兼容或需要修改决策方案时，按需读取[官方 Skill](https://github.com/trycua/cua/blob/main/skills/jev-use/SKILL.md)与[官方例程](https://github.com/trycua/cua/tree/main/libs/cua-driver/examples/jev-use)，核验当前 revision 的协议，避免套用旧字段。
