# NK 订单管理后台

GitHub 仓库：allanfetzer379-hub/health-life-admin
预定后台地址：https://allanfetzer379-hub.github.io/health-life-admin/
落地页：https://allanfetzer379-hub.github.io/health-life-landing/

## 当前状态

后台与订单接入代码已准备；config.ready 为 false 时只展示部署准备页面，不允许登录、读写订单。须完成下列 Supabase 配置和在线验收后，才算正式开通。数据库尚未创建时，勿将此状态当成可收单。

## 本地运行

`node server.mjs` 后打开 http://127.0.0.1:4180 。`node --test tests.mjs` 运行纯逻辑测试。无需安装前端依赖。

## 配置 Supabase

1. 新建免费的 health-life-orders 项目。项目密码由账号所有者设置。关闭自动暴露新表，启用 RLS。
2. 执行 supabase/migrations/202610110001_orders.sql。
3. 通过 SQL Editor 将授权管理员邮箱插入 private.admin_members。只有该表中的邮箱经过 Supabase Auth 登录，才可访问后台。
4. Auth URL Configuration：Site URL 为后台地址；Redirect URLs 添加该完整地址。邮件登录使用项目 Auth，不是 Supabase 控制台登录态。默认邮件服务的收件人限制和速率限制需在实际登录时验证；扩大使用前配置自己的 SMTP。
5. 部署 supabase/functions/submit-order/index.ts，函数名 submit-order，采用 config.toml 的匿名公开提交模式。订单表禁止匿名读取、写入；仅此函数可调用受保护的提交事务。使用项目默认服务端环境变量，不将服务密钥放入前端或 Git。
6. 运行 `node tools/configure.mjs <项目URL> <publishable或anon公开密钥>`，同时填写后台和同级 landing-page 的公开配置。
7. main 保存源码，gh-pages 发布 dist 的内容。落地页接入文件也需同步部署。

## 验收要求

- 未登录无法读取订单；未授权登录账号无法读取订单或修改像素。
- 管理员可登录、查询、修改状态和备注、导出、保存 FB/TikTok 像素。
- 提交正常订单、仅姓名相同、仅电话相同、双重匹配和同请求重试；确认去重与幂等。
- 验证真实网关传入 x-forwarded-for 的语义，拒绝客户端伪造 IP；目前函数实现需经线上验证后才开放收单。
- 验证成功响应之后才跳转成功页；失败可重试。
- 验证广告 ID、UA/IP 入库，像素仅在配置启用时加载；表单转化不等于已付款。
- 清理自己创建的测试订单。

## 数据与功能

后台简体中文，客户姓名原样保存和显示；仅查重时统一格式。姓名或电话任一匹配即标记。列表直接修改状态、无效原因、一键复制；日期、来源、广告 ID、状态与重粉筛选。IP、UA 与广告 ID 随下单保存。像素 ID 与广告 ID 是不同字段。

数据与像素配置来自 Supabase，后台不再使用本地演示订单。数据库脚本内不含真实客户资料和管理员账号。publishable/anon key 可以公开，service-role key 和数据库密码严禁公开。
