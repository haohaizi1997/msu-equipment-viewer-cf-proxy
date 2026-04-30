# MSU Equipment Viewer CF Proxy

这个版本用于部署到 `Cloudflare Pages`，通过 `Pages Functions` 代理请求 `msu.io`，避免浏览器直接请求时的 CORS 拦截。

## 文件结构

```text
msu-equipment-viewer-cf-proxy/
├── app.js
├── functions/
│   └── api/
│       └── proxy.js
├── index.html
├── README.md
└── style.css
```

## 这是不是单独的服务器

不是。

- `functions/api/proxy.js` 是跑在 `Cloudflare` 边缘网络上的后端代码
- 它类似一个很轻量的后端入口，但不是你自己再开一台服务器
- 你不需要再准备 `VPS`、`Mac mini`、`Node 进程` 或公网端口

## 工作方式

1. 浏览器访问你的 Pages 站点
2. 前端调用同源接口 `/api/proxy`
3. Cloudflare Function 再去请求 `https://msu.io/navigator/api/navigator/...`
4. Function 把结果回给前端

这样浏览器不会直接跨域请求 `msu.io`，所以能绕开当前看到的 CORS 限制。

## 部署方式

这个版本推荐使用 `Git integration`，不要用纯拖拽上传。

1. 把 `msu-equipment-viewer-cf-proxy` 放到 GitHub 仓库
2. 登录 Cloudflare
3. 进入 `Workers & Pages`
4. 点击 `Create application`
5. 选择 `Pages`
6. 选择 `Connect to Git`
7. 授权并选择你的 GitHub 仓库
8. 如果仓库根目录就是这个项目：
   `Build command` 留空，`Build output directory` 填 `.`
9. 如果仓库上层还有别的文件夹：
   `Root directory` 填 `msu-equipment-viewer-cf-proxy`
   `Build command` 留空
   `Build output directory` 填 `.`
10. 点击 `Save and Deploy`

部署完成后，打开你的 `*.pages.dev` 域名即可。

## 实现说明

- 前端统一调用同源 `/api/proxy`
- `proxy.js` 只允许代理 `https://msu.io/navigator/api/navigator/` 下的 URL
- 分页大小固定为 `20`
- 页内请求并发固定为 `3`
- 搜索新装备时会清空缓存
- 单个编号失败不会中断整页

## 注意

- 这个版本依赖 `Cloudflare Pages Functions`
- 如果你用 `Direct Upload`，需要确认该部署方式是否包含 `functions/` 目录的执行能力；为避免歧义，建议直接用 `Git integration`
- 如果 `msu.io` 后续改了接口结构或加了鉴权，需要继续调整 `app.js` 和 `functions/api/proxy.js`
