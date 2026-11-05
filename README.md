# sftc-open-cli

顺丰同城开放平台 CLI 工具 —— 为人和 AI 智能体提供同城即时配送能力。

> 安装后的命令行程序名为 `sf-clite`。

## 功能

- **login / whoami / logout** — 浏览器授权与登录态管理
- **addr** — 地址解析（文本 → 城市 / 街道 / 楼宇 / 经纬度）
- **cities** — 查询已开通服务的城市
- **options** — 查询物品类型与重量规则
- **quote** — 订单询价（不产生订单）
- **place** — 创建订单
- **pay** — 生成支付参数（微信 / 支付宝）
- **show** — 查询订单详情
- **reasons** — 查询取消费用与可用原因
- **cancel** — 取消订单
- **orders** — 查看本机发单记录
- **skill** — 安装 / 卸载为 AI 客户端技能
- **tools / config / raw** — 能力探查、连接配置、逃生舱
- **version** — 显示版本与运行环境

## 安装

### 环境要求

- **Node.js ≥ 16**
- 首次使用需要浏览器完成一次账号授权

### 方式一：从 GitHub Releases 安装（推荐）

```bash
# 1. 下载安装包（链接以正式发布地址为准）
curl -LO https://github.com/<org>/<repo>/releases/download/v1.2.0/sftc-open-cli-1.2.0.tgz

# 2. 全局安装
npm i -g sftc-open-cli-1.2.0.tgz
```

安装完成后即可使用 `sf-clite` 命令。

### 方式二：从 npm registry 安装

发布到 registry 后可直接安装：

```bash
npm i -g sftc-open-cli
```

### 验证安装

```bash
sf-clite version
```

```json
{"ok":true,"name":"sftc-open-cli","version":"1.2.0","runtime":"node v23.10.0","platform":"darwin","api":"MCP 2025-06-18"}
```

## 使用

```bash
# 查看版本
sf-clite version

# 列出所有命令
sf-clite --help

# 授权登录（首次使用）
sf-clite login

# 查看授权状态
sf-clite whoami

# 查询已开通城市
sf-clite cities

# 解析地址（寄件方 / 收件方各一次）
sf-clite addr --side sender   --keyword "北京市海淀区奥北科技园东区国泰大厦"
sf-clite addr --side receiver --keyword "北京市海淀区安宁庄东路7号"

# 查询物品类型与重量规则
sf-clite options

# 询价（不产生订单）
sf-clite quote \
  --from-addr-json '{"name":"张三","phone":"13800138000","lat":"40.032412","lng":"116.377333","cityId":111000000,"cityName":"北京市","street":"海淀区奥北科技园东区","building":"国泰大厦"}' \
  --to-addr-json   '{"name":"李四","phone":"13900139000","lat":"40.045488","lng":"116.327914","cityId":111000000,"cityName":"北京市","street":"海淀区安宁庄东路7号","building":"融科融智蜂巢工场"}' \
  --product-type 12 --product-name "商务文件" --product-weight 1

# 确认后创建订单
sf-clite place --preview-file ~/.sf-intra-city-skill/quote-latest.json --yes

# 获取支付方式（不代表已支付）
sf-clite pay --order-id "8344485710485" --method WX

# 查询订单
sf-clite show --order-id "8344485710485"

# 查询取消费用
sf-clite reasons --order-id "8344485710485"

# 取消订单
sf-clite cancel --order-id "8344485710485" --yes

# 查看本机发单记录
sf-clite orders
```

### 两条硬性规则

1. **价格不可指定**。`quote` 返回的报价凭证就是最终价格；报价有效期约 10 分钟，过期需重新询价并再次确认。
2. **发单与取消必须带 `--yes`**。这是写操作闸门，避免误触发。

### 物品类型

| product_type | 物品 | 默认重量 |
|---|---|---|
| 12 | 商务文件（默认） | 1kg |
| 21 | 食品 | 2kg |
| 6 | 生鲜 | 2kg |
| 13 | 蛋糕 | 3kg |
| 14 | 鲜花 | 2kg |
| 15 | 精密数码 | 3kg |
| 16 | 奢品服饰 | 3kg |
| 18 | 黄金珠宝 | 1kg |
| 80 | 名牌箱包 | 1kg |
| 2 | 药品 | 1kg |
| 36 | 证照 | 1kg |
| 99 | 其他 | 1kg |

> 重量单位为**千克（整数，上限 50kg）**。「不到一公斤」传 `1`，不要传 `1000`。完整列表以 `sf-clite options` 返回为准。

## AI 智能体集成

安装包内置 Agent Skill，安装后 Claude Code / Cursor 等智能体可通过自然语言直接完成询价、下单、支付与查单。

### 安装 Skill

```bash
# 安装到 Claude Code 用户级 skills 目录（默认 ~/.claude/skills）
sf-clite skill install

# 安装到指定目录（项目级或其他客户端）
sf-clite skill install --root <目录>

# 卸载
sf-clite skill uninstall
```

安装完成后**重启客户端会话**，即可在对话中使用「顺丰同城急送」技能。

> CLI 与技能共用同一份登录态和订单记录：终端里下的单，对话里能查到；反之亦然。

### Skill 内容

| 组件 | 路径 | 说明 |
|---|---|---|
| 主 Skill | `SKILL.md` | 能力边界、安全红线、话术规范 |
| 动作脚本 | `scripts/clite.js` | 询价、发单、支付、查单、取消 |

### 支持的客户端

| 客户端 | 状态 |
|---|---|
| Claude Code | 已验证（用户级 / 项目级 skills 目录） |
| Cursor 及其他支持 skills 的客户端 | 通过 `--root` 指定其 skills 目录；具体位置以客户端文档为准 |

## 认证与配置

### 交互式授权

```bash
sf-clite login
```

浏览器弹出后使用顺丰账号授权，凭证自动保存，后续命令免登录。

### 无浏览器环境

```bash
# 只输出授权链接
sf-clite login --print-url

# 用户在任意设备完成登录后，粘贴完整回调 URL
sf-clite login --redirect-url "http://localhost:xxxxx/?code=..."
```

### 环境变量（CI / 容器）

| 变量 | 内容 | 适用 |
|---|---|---|
| `CLITE_SESSION` | 完整会话 JSON（含 `refresh_token`，支持自动续期） | 长时间运行的流水线 |
| `CLITE_TOKEN` | 仅 access token | 短期单次调用 |

```bash
export CLITE_SESSION='{"access_token":"...","refresh_token":"...","token_endpoint":"...","client_id":"..."}'
sf-clite whoami
```

> 环境变量只影响本次进程，不会回写本机凭证。`CLITE_SESSION` 含 refresh token，请通过 CI secret 注入，禁止打印到日志。

### 本机数据

| 内容 | 位置 |
|---|---|
| 登录态（macOS） | 系统钥匙串，service `clite-mcp-session` |
| 登录态（Linux / Windows） | `~/.sf-intra-city-skill/session.json`，权限 `0600` |
| 订单索引 | `~/.sf-intra-city-skill/orders.json` |
| 报价凭证 | `~/.sf-intra-city-skill/quote-latest.json` |

换机器或换运行环境需要重新授权一次。

## 输出与退出码

所有命令的 stdout 是单行 JSON，错误走 stderr，便于脚本解析。

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 服务端或网络错误 |
| `2` | 参数错误，或需要用户确认 |
| `3` | 未登录 / 无权限 |

```bash
if ! out=$(sf-clite quote "$@"); then
  code=$(echo "$out" | jq -r '.code')
  case "$code" in
    "[AUTH_REQUIRED]") sf-clite login && exec "$0" "$@" ;;
    *) echo "失败: $code"; exit 1 ;;
  esac
fi
```

## 更新

CLI 通过重新安装升级，配置与登录态不受影响：

```bash
curl -LO https://github.com/<org>/<repo>/releases/latest/download/sftc-open-cli-<版本>.tgz
npm i -g sftc-open-cli-<版本>.tgz
sf-clite skill install      # 同步更新技能副本
```

## 卸载

```bash
# 1. 卸载技能副本
sf-clite skill uninstall

# 2. 卸载 CLI
npm uninstall -g sftc-open-cli

# 3. 清除本机数据（可选，会删除登录态与订单记录）
rm -rf ~/.sf-intra-city-skill
```

## 开发

本项目无构建步骤：核心逻辑集中在 `scripts/clite.js` 单文件，仅使用 Node.js 内置模块，无第三方依赖。

```bash
node scripts/clite.js --help
```

## License

Proprietary
