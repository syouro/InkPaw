# 公网 HTTPS + OAuth 部署

InkPaw 的远程 MCP 模式支持 OAuth 2.1 授权码流程、PKCE S256、动态客户端注册、短期访问令牌、刷新令牌轮换、目标资源绑定和撤销。stdio 与本地 Bearer Token 模式保持兼容；公网部署应显式启用 OAuth。

## 1. 准备稳定域名和 HTTPS

把一个长期使用的域名（例如 `mcp.example.com`）的 DNS A/AAAA 记录指向服务器。推荐让 Caddy、OpenResty、Nginx 或云负载均衡器终止 TLS，InkPaw 只监听本机回环地址。

Caddy 示例位于 [`deploy/Caddyfile.example`](../deploy/Caddyfile.example)：

```bash
caddy run --config deploy/Caddyfile.example
```

若已有证书，也可以让 InkPaw 直接提供 HTTPS，同时设置：

```bash
export DOCX_MCP_TLS_CERT=/absolute/path/to/fullchain.pem
export DOCX_MCP_TLS_KEY=/absolute/path/to/privkey.pem
export DOCX_MCP_HOST=0.0.0.0
```

`DOCX_MCP_TLS_CERT` 与 `DOCX_MCP_TLS_KEY` 必须同时设置。生产环境不要使用临时隧道域名或自签名证书。

## 2. 启用 OAuth

```bash
export DOCX_MCP_AUTH=oauth
export DOCX_MCP_PUBLIC_URL=https://mcp.example.com/mcp
export DOCX_MCP_OAUTH_PASSWORD='请替换为至少12字符的高强度随机密码'
export DOCX_MCP_HOST=127.0.0.1
export DOCX_MCP_PORT=8765
export DOCX_MCP_TRUST_PROXY=1
npm run start:http
```

`DOCX_MCP_PUBLIC_URL` 是平台填写的最终公网地址，必须精确到 `/mcp`。非本机 OAuth 地址若不是 HTTPS，服务会拒绝启动。`DOCX_MCP_OAUTH_PASSWORD` 用于资源所有者在授权页确认或拒绝访问，不会写入数据库。

OAuth 客户端、授权码及令牌默认持久化到 `data/oauth.db`。生产环境可用 `DOCX_MCP_OAUTH_DB` 改到持久卷；该文件包含敏感授权状态，必须限制文件权限并纳入加密备份。

## 3. 平台发现端点

启用 OAuth 后会提供：

| 地址 | 用途 |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 受保护资源元数据 |
| `/.well-known/oauth-authorization-server` | RFC 8414 授权服务器元数据 |
| `/register` | 动态客户端注册 |
| `/authorize` | 用户登录、同意或拒绝授权 |
| `/token` | 授权码交换及刷新令牌轮换 |
| `/revoke` | RFC 7009 客户端令牌撤销 |
| `/oauth/authorizations` | 资源所有者查看并撤销整个授权 |

访问令牌有效期为 1 小时，刷新令牌有效期为 30 天。刷新令牌每次使用后立即失效并换发新令牌；访问令牌只接受 `mcp:tools` scope，并严格绑定 `DOCX_MCP_PUBLIC_URL` 指定的目标资源。OAuth 产生的文档数据按授权用户 UUID 隔离。

## 4. 健康检查

以下端点无需授权，均返回简短 JSON 且禁止缓存：

```text
GET /health
GET /readyz
```

监控系统应检查 HTTP 200，以及响应中的 `status: "ok"`。健康检查仅表示进程和核心存储已完成初始化，不会泄露 token、用户或文档数据。

## 5. 上线检查

```bash
curl -fsS https://mcp.example.com/health
curl -fsS https://mcp.example.com/.well-known/oauth-protected-resource/mcp
curl -fsS https://mcp.example.com/.well-known/oauth-authorization-server
```

确认最终 URL 没有 HTTP 降级或跳到临时域名；防火墙只公开 443，InkPaw 的内部 8765 端口不应直接暴露。OAuth 数据库和 `data/users/` 必须放在持久存储上。
